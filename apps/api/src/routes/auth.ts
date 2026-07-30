import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTransaction, pool } from "../db.ts";
import { issueChallenge, OtpError, recentFailures, verifyChallenge } from "../auth/otp.ts";
import { otpMessage, senderFromEnv } from "../auth/sms.ts";
import {
  hashRefreshToken, newRefreshToken, REFRESH_TOKEN_TTL_MS, signAccessToken,
} from "../auth/token.ts";
import { membershipsForPhone, membershipVersion } from "../auth/membership.ts";

/**
 * Login without passwords (Story 1.2).
 *
 * Under thirty seconds on a low-cost Android: one phone field, one code,
 * straight into the person's own home screen.
 */

// India-first, but E.164 so a +971 committee member abroad still logs in.
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => /^\+[1-9]\d{7,14}$/.test(v), "enter a phone number with country code, e.g. +9198…");

const requestBody = z.object({
  phone: phoneSchema,
  channel: z.enum(["sms", "voice"]).optional(),
});

const verifyBody = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, "the code is six digits"),
  installId: z.string().uuid().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const sender = senderFromEnv();

  /**
   * Request a code.
   *
   * Always answers the same way, whether or not the number is known. Telling a
   * caller "that number isn't registered" hands them a directory of which
   * numbers are. The honest "you're not in a society yet" message belongs
   * after the code is verified (Flow A4), where we know we are talking to the
   * person who holds the number.
   */
  app.post(
    "/auth/otp/request",
    { config: { policyPublic: true } },
    async (request, reply) => {
      const parsed = requestBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
      }
      const { phone, channel } = parsed.data;

      try {
        const issued = await inTransaction(async (tx) => {
          const failures = await recentFailures(tx, phone);
          const chosen = channel ?? (failures >= 2 ? "voice" : "sms");
          const result = await issueChallenge(tx, { phone, ip: request.ip, channel: chosen });
          return { ...result, channel: chosen };
        });

        // Delivery happens outside the transaction: a provider timeout must not
        // roll back a challenge the user may already have received.
        const language = "en"; // society language is not known until we know the society
        await sender.send(phone, otpMessage(issued.code, language));

        return {
          sent: true,
          channel: issued.channel,
          expiresInSeconds: Math.round((issued.expiresAt.getTime() - Date.now()) / 1000),
        };
      } catch (err) {
        if (err instanceof OtpError && err.code === "rate_limited") {
          return reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
        }
        request.log.error({ err }, "otp request failed");
        return reply.code(502).send({ error: "Could not send the code. Try again." });
      }
    },
  );

  /**
   * Verify a code and issue a session.
   *
   * Three outcomes, matching Flow A4/B2/B4: not in any society (honest dead
   * end, no self-signup in the MVP), exactly one society (straight in), or
   * several (picker).
   */
  app.post(
    "/auth/otp/verify",
    { config: { policyPublic: true } },
    async (request, reply) => {
      const parsed = verifyBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
      }
      const { phone, code } = parsed.data;
      const installId = parsed.data.installId ?? randomUUID();

      try {
        await inTransaction((tx) => verifyChallenge(tx, { phone, code }));
      } catch (err) {
        if (err instanceof OtpError) {
          const status = err.code === "wrong_code" ? 401 : 400;
          return reply.code(status).send({ error: err.message, reason: err.code });
        }
        throw err;
      }

      const memberships = await membershipsForPhone(phone);

      if (memberships.length === 0) {
        // Flow B2e — a deliberate dead end. A member cannot add themselves.
        return reply.code(200).send({
          status: "not_in_any_society",
          message:
            "This number isn't in any society yet. Ask your committee to add you — " +
            "they can do it in a moment from their phone.",
        });
      }

      const sessions = await Promise.all(
        memberships.map((m) => issueSession(m.personId, m.societyId, m.role, installId)),
      );

      if (memberships.length === 1) {
        const membership = memberships[0]!;
        return {
          status: "signed_in",
          society: { id: membership.societyId, name: membership.societyName },
          you: { name: membership.displayName, role: membership.role, seat: membership.committeeSeat },
          ...sessions[0]!,
        };
      }

      // Flow B4 — the picker. Each society gets its own token because the
      // token's scope IS the society.
      return {
        status: "choose_society",
        societies: memberships.map((m, i) => ({
          id: m.societyId,
          name: m.societyName,
          role: m.role,
          seat: m.committeeSeat,
          ...sessions[i]!,
        })),
      };
    },
  );

  /** Exchange a refresh token for a new access token. */
  app.post(
    "/auth/refresh",
    { config: { policyPublic: true } },
    async (request, reply) => {
      const parsed = z.object({ refreshToken: z.string().min(20) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "refreshToken is required" });

      const hash = hashRefreshToken(parsed.data.refreshToken);
      const { rows } = await pool.query<{
        id: string; person_id: string; society_id: string; install_id: string;
      }>(
        `SELECT id, person_id, society_id, install_id FROM refresh_token
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [hash],
      );
      const row = rows[0];
      if (!row) return reply.code(401).send({ error: "session expired" });

      const { activeMembership } = await import("../auth/membership.ts");
      const membership = await activeMembership(row.person_id, row.society_id);
      if (!membership) {
        // Revoked while the session was idle. Kill the row so it cannot be
        // retried, and answer the same way as any expired session.
        await pool.query(`UPDATE refresh_token SET revoked_at = now() WHERE id = $1`, [row.id]);
        return reply.code(401).send({ error: "session expired", reason: "no longer a member" });
      }

      await pool.query(`UPDATE refresh_token SET last_used_at = now() WHERE id = $1`, [row.id]);

      const mv = await membershipVersion(row.society_id);
      return {
        accessToken: signAccessToken({
          sub: row.person_id,
          soc: row.society_id,
          role: membership.role,
          mv,
          iid: row.install_id,
        }),
      };
    },
  );

  /** Who am I, and what may I do — drives the role-based home (Flow B3). */
  app.get("/auth/me", { config: { policyAction: "society.read" } }, async (request) => {
    const actor = request.actor!;
    const { ROLE_COPY, actionsFor } = await import("@sr/policy");
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM society WHERE id = $1`,
      [actor.societyId],
    );
    return {
      you: {
        name: actor.displayName,
        role: actor.role,
        label: ROLE_COPY[actor.role].label,
        can: ROLE_COPY[actor.role].can,
      },
      society: { id: actor.societyId, name: rows[0]?.name },
      permissions: actionsFor(actor.role),
    };
  });
}

async function issueSession(
  personId: string,
  societyId: string,
  role: string,
  installId: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const mv = await membershipVersion(societyId);
  const accessToken = signAccessToken({ sub: personId, soc: societyId, role, mv, iid: installId });
  const { token, hash } = newRefreshToken();

  await pool.query(
    `INSERT INTO refresh_token (id, token_hash, person_id, society_id, install_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), hash, personId, societyId, installId, new Date(Date.now() + REFRESH_TOKEN_TTL_MS)],
  );

  return { accessToken, refreshToken: token };
}
