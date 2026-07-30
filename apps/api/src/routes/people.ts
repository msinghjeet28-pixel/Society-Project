import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROLES, COMMITTEE_SEATS } from "@sr/envelope/core";
import { ROLE_COPY } from "@sr/policy";
import { inTransaction, pool } from "../db.ts";
import {
  grantRole, MembershipError, revokeRefreshTokens, revokeRole,
} from "../auth/membership.ts";

/**
 * Managing people and roles (Story 1.3, Flow C).
 *
 * Every route here resolves the society from the actor, never from the request.
 * A society id in a path is checked against the actor's scope and 404s on
 * mismatch — "not found" rather than "forbidden", because confirming a
 * society's existence to an outsider is itself a leak.
 */

const addPersonBody = z.object({
  name: z.string().trim().min(1, "a name is required").max(120),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => /^\+[1-9]\d{7,14}$/.test(v), "enter a phone number with country code")
    .optional(),
  role: z.enum(ROLES),
  committeeSeat: z.enum(COMMITTEE_SEATS).optional(),
});

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  /** The People list, grouped by role with counts (Flow C1). */
  app.get("/people", { config: { policyAction: "person.read" } }, async (request) => {
    const actor = request.actor!;
    const { rows } = await pool.query<{
      person_id: string; display_name: string; role: string; committee_seat: string | null;
    }>(
      `SELECT ma.person_id, p.display_name, ma.role, ma.committee_seat
         FROM membership_active ma
         JOIN person p ON p.id = ma.person_id
        WHERE ma.society_id = $1
        ORDER BY CASE ma.role
                   WHEN 'committee' THEN 1 WHEN 'staff' THEN 2
                   WHEN 'accountant' THEN 3 ELSE 4 END,
                 p.display_name`,
      [actor.societyId],
    );

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = groups.get(row.role) ?? [];
      list.push(row);
      groups.set(row.role, list);
    }

    return {
      groups: [...groups.entries()].map(([role, members]) => ({
        role,
        label: ROLE_COPY[role as keyof typeof ROLE_COPY].label,
        count: members.length,
        people: members.map((m) => ({
          id: m.person_id,
          name: m.display_name,
          seat: m.committee_seat,
        })),
      })),
    };
  });

  /** Add a person directly, any time — never through a file (Story 1.3 · 6). */
  app.post("/people", { config: { policyAction: "person.add" } }, async (request, reply) => {
    const actor = request.actor!;
    const parsed = addPersonBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
    }
    const { name, phone, role, committeeSeat } = parsed.data;

    if (role !== "committee" && committeeSeat) {
      return reply.code(400).send({ error: "only committee members hold a seat" });
    }

    try {
      const personId = randomUUID();
      await inTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO person (id, society_id, display_name, phone_e164) VALUES ($1,$2,$3,$4)`,
          [personId, actor.societyId, name, phone ?? null],
        );
        await grantRole(tx, {
          societyId: actor.societyId,
          personId,
          role,
          committeeSeat: committeeSeat ?? null,
          actor: { id: actor.personId, name: actor.displayName, role: actor.role },
          installId: actor.installId,
        });
      });

      return reply.code(201).send({
        id: personId,
        name,
        role,
        // Members get no login in the MVP; adding one enables receipts and updates.
        needsInvite: role !== "member",
        permissionSentence: ROLE_COPY[role].can,
      });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        return reply.code(409).send({ error: "that phone number is already in this society" });
      }
      throw err;
    }
  });

  /**
   * Remove a role. Instant, device-independent (Story 1.3 edge case).
   *
   * Past entries stay in the record under their name — the confirmation copy in
   * Flow C5 promises exactly that, and the append-only ledger delivers it
   * without any work here.
   */
  app.post(
    "/people/:personId/revoke",
    { config: { policyAction: "person.role.revoke" } },
    async (request, reply) => {
      const actor = request.actor!;
      const params = z.object({ personId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "bad person id" });

      try {
        const result = await inTransaction(async (tx) => {
          const eventId = await revokeRole(tx, {
            societyId: actor.societyId,
            personId: params.data.personId,
            role: "staff", // replaced by the role actually held
            actor: { id: actor.personId, name: actor.displayName, role: actor.role },
            installId: actor.installId,
          });
          const killed = await revokeRefreshTokens(tx, params.data.personId, actor.societyId);
          return { eventId, sessionsEnded: killed };
        });

        return {
          revoked: true,
          ...result,
          message: "Access ended on every device. Past entries stay in the record, under their name.",
        };
      } catch (err) {
        if (err instanceof MembershipError) {
          const status = err.code === "not_a_member" ? 404 : 409;
          return reply.code(status).send({ error: err.message, reason: err.code });
        }
        throw err;
      }
    },
  );

  /**
   * Chain status for the actor's own society.
   *
   * The path carries an id so the URL is honest, but the id is checked against
   * the actor's scope rather than used to look anything up.
   */
  app.get(
    "/societies/:societyId/chain",
    { config: { policyAction: "society.read" } },
    async (request, reply) => {
      const actor = request.actor!;
      const params = z.object({ societyId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: "not found" });

      if (params.data.societyId !== actor.societyId) {
        // Cross-tenant access. 404, not 403 — see the note at the top.
        request.log.warn(
          { actorSociety: actor.societyId, requested: params.data.societyId },
          "cross-society access refused",
        );
        return reply.code(404).send({ error: "not found" });
      }

      const { rows } = await pool.query<{ chain_head: string; entries: string }>(
        `SELECT s.chain_head,
                (SELECT count(*) FROM membership_event me WHERE me.society_id = s.id)::text AS entries
           FROM society s WHERE s.id = $1`,
        [actor.societyId],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "not found" });

      return { chainHead: row.chain_head, entries: Number(row.entries) };
    },
  );
}
