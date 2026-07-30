import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db.ts";

/**
 * One-time codes (Story 1.2).
 *
 * Design notes that matter more than the code:
 *
 *  · Codes are stored as a keyed hash. Reading this table must not let anyone
 *    log in as a treasurer, and neither must a leaked backup.
 *  · Rate limits are per phone AND per IP. Without the IP limit, one attacker
 *    walks a number range; without the phone limit, one number gets flooded
 *    with real SMS at our cost.
 *  · A wrong code increments attempts and burns the challenge after three.
 *    Unlimited attempts on a six-digit code is not a login, it is a lock with
 *    the key taped to it.
 */

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

/** Per phone, per window. Generous enough for a real user losing the SMS. */
export const PHONE_LIMIT = 3;
export const PHONE_WINDOW_MS = 15 * 60 * 1000;

/** Per IP, per window. Catches range-walking. */
export const IP_LIMIT = 12;
export const IP_WINDOW_MS = 60 * 60 * 1000;

export type OtpFailure =
  | "rate_limited"
  | "no_challenge"
  | "expired"
  | "wrong_code"
  | "exhausted";

export class OtpError extends Error {
  // Assigned explicitly rather than as a constructor parameter property:
  // parameter properties need code generation, and Node's type stripping only
  // erases types. Vitest's esbuild accepts them, so the tests pass while the
  // deployed entrypoint refuses to boot — see the smoke-boot gate.
  readonly code: OtpFailure;

  constructor(message: string, code: OtpFailure) {
    super(message);
    this.name = "OtpError";
    this.code = code;
  }
}

function codePepper(): string {
  const key = process.env["JWT_SIGNING_KEY"];
  if (!key) throw new Error("JWT_SIGNING_KEY is required to hash OTP codes");
  return key;
}

function hashCode(phone: string, code: string): Buffer {
  // Binding the hash to the phone number means a code issued for one number
  // cannot be replayed against another.
  return createHmac("sha256", codePepper()).update(`${phone}:${code}`, "utf8").digest();
}

export function generateCode(): string {
  // randomInt is CSPRNG-backed; Math.random would make codes guessable.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

export interface IssuedChallenge {
  challengeId: string;
  code: string;
  expiresAt: Date;
}

export async function issueChallenge(
  tx: Queryable,
  opts: { phone: string; ip?: string | undefined; channel?: "sms" | "voice" | "manual" },
  now: Date = new Date(),
): Promise<IssuedChallenge> {
  const { rows: phoneRows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM otp_challenge
      WHERE phone_e164 = $1 AND created_at > $2`,
    [opts.phone, new Date(now.getTime() - PHONE_WINDOW_MS)],
  );
  if (Number(phoneRows[0]!.n) >= PHONE_LIMIT) {
    throw new OtpError("too many codes requested for this number", "rate_limited");
  }

  if (opts.ip) {
    const { rows: ipRows } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM otp_challenge
        WHERE request_ip = $1 AND created_at > $2`,
      [opts.ip, new Date(now.getTime() - IP_WINDOW_MS)],
    );
    if (Number(ipRows[0]!.n) >= IP_LIMIT) {
      throw new OtpError("too many codes requested from this network", "rate_limited");
    }
  }

  const challengeId = randomUUID();
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

  await tx.query(
    `INSERT INTO otp_challenge (id, phone_e164, code_hash, channel, request_ip, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      challengeId,
      opts.phone,
      hashCode(opts.phone, code),
      opts.channel ?? "sms",
      opts.ip ?? null,
      now,
      expiresAt,
    ],
  );

  return { challengeId, code, expiresAt };
}

/**
 * Verifies and consumes a code. Returns the phone number the code proved
 * control of; the caller resolves memberships from there.
 */
export async function verifyChallenge(
  tx: Queryable,
  opts: { phone: string; code: string },
  now: Date = new Date(),
): Promise<{ phone: string }> {
  // FOR UPDATE so two concurrent guesses cannot each see attempts = 2.
  const { rows } = await tx.query<{
    id: string;
    code_hash: Buffer;
    attempts: number;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM otp_challenge
      WHERE phone_e164 = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [opts.phone],
  );

  const challenge = rows[0];
  if (!challenge) throw new OtpError("no code was requested for this number", "no_challenge");

  if (challenge.expires_at <= now) {
    throw new OtpError("that code has expired — request a new one", "expired");
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    throw new OtpError("too many wrong attempts — request a new code", "exhausted");
  }

  const provided = hashCode(opts.phone, opts.code);
  const matches =
    provided.length === challenge.code_hash.length &&
    timingSafeEqual(provided, challenge.code_hash);

  if (!matches) {
    await tx.query(`UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1`, [
      challenge.id,
    ]);
    throw new OtpError("that code is not right", "wrong_code");
  }

  await tx.query(`UPDATE otp_challenge SET consumed_at = $2 WHERE id = $1`, [challenge.id, now]);
  return { phone: opts.phone };
}

/** How many failures the caller has already had — drives the voice fallback. */
export async function recentFailures(tx: Queryable, phone: string): Promise<number> {
  const { rows } = await tx.query<{ attempts: number }>(
    `SELECT attempts FROM otp_challenge
      WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  return rows[0]?.attempts ?? 0;
}
