import { z } from "zod";

/**
 * The entry envelope — carried by every ledger row (Arch §04).
 *
 * Uniformity here is what makes the audit trail, the export, and the
 * correction mechanism single implementations rather than one per entity.
 */

export const ROLES = ["committee", "staff", "accountant", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Committee seats. The word "office bearer" never appears in user-facing text. */
export const COMMITTEE_SEATS = ["president", "secretary", "treasurer"] as const;
export type CommitteeSeat = (typeof COMMITTEE_SEATS)[number];

export const uuid = z.string().uuid();

/** ISO-8601 with offset. Two clocks are stored per entry, never one. */
export const timestamp = z.string().datetime({ offset: true });

/**
 * Written by the client. `id` is minted client-side and is the idempotency
 * key: a retry after a dropped response is safe because the ledger's
 * uniqueness constraint absorbs it (Arch §06).
 */
export const clientEnvelope = z.object({
  id: uuid,
  /** When it really happened, from the device clock. Never overwritten. */
  occurredAt: timestamp,
  /**
   * Client-declared dependency on an earlier entry in this or a prior batch.
   * An entry whose dependency was rejected is rejected too, rather than
   * applied against a missing parent (Tech Design §04 critique).
   */
  dependsOn: uuid.optional(),
});
export type ClientEnvelope = z.infer<typeof clientEnvelope>;

/**
 * Added by the server. `actorName` and `actorRole` are denormalised on
 * purpose: the record describes the past, so a join to current membership
 * would quietly rewrite it when someone's role changes.
 *
 * `installId` is recorded but never shown — user-facing copy says
 * "from her registered phone" (Arch §14 №4).
 */
export const serverEnvelope = z.object({
  societyId: uuid,
  actorId: uuid,
  actorName: z.string().min(1),
  actorRole: z.enum(ROLES),
  installId: uuid,
  recordedAt: timestamp,
  clockSkewMs: z.number().int(),
  prevHash: z.string().length(64),
  entryHash: z.string().length(64),
});
export type ServerEnvelope = z.infer<typeof serverEnvelope>;

/** A correction is a new entry pointing at the original. Reason is mandatory. */
export const correctionRef = z.object({
  correctsId: uuid,
  correctReason: z.string().trim().min(1, "a correction must carry its reason"),
});
export type CorrectionRef = z.infer<typeof correctionRef>;

/**
 * Flags that live on entries and must render from ledger state, never from a
 * string someone remembered to set (Arch §08).
 */
export const ENTRY_FLAGS = [
  "emergency",
  "no_bill_provided",
  "fund_override",
  "paid_personally",
  "synced_after_role_ended",
  "clock_skew_high",
] as const;
export type EntryFlag = (typeof ENTRY_FLAGS)[number];

export const entryFlag = z.enum(ENTRY_FLAGS);

/** Clock skew beyond this routes an entry to the committee queue (§04 critique). */
export const SKEW_QUARANTINE_MS = 48 * 60 * 60 * 1000;

/** Skew beyond this is flagged on the entry and tracked as a fleet metric. */
export const SKEW_FLAG_MS = 5 * 60 * 1000;

export function skewVerdict(skewMs: number): {
  flag: boolean;
  quarantine: boolean;
} {
  const abs = Math.abs(skewMs);
  return { flag: abs > SKEW_FLAG_MS, quarantine: abs > SKEW_QUARANTINE_MS };
}
