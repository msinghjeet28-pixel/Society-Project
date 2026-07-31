import { randomUUID } from "node:crypto";
import { hashEntry } from "@sr/envelope/core";
import type { Role } from "@sr/envelope/core";
import type { Queryable } from "../db.ts";

/**
 * Corrections (Story 1.4, Arch §04, Tech Design §06).
 *
 * "No user, including us as the vendor, can edit or delete a submitted entry. A
 * correction creates a new entry linked to the original, showing who corrected
 * it, when, and the stated reason."
 *
 * One generic implementation for every ledger entity, deliberately. The shared
 * envelope is what allows that, and the alternative — bespoke correction
 * handling per entity, discovered in week six — is the mistake the architecture
 * warned about by name. Expenses and payments will register here rather than
 * grow their own version of this.
 *
 * Nothing about the original changes, including its "corrected" status: that is
 * derived from the existence of a correction, which is why the projections are
 * views rather than columns.
 */

export type CorrectionFailure =
  | "not_found"
  | "already_corrected"
  | "not_your_entry"
  | "reason_required"
  | "pending_approval";

export class CorrectionError extends Error {
  readonly code: CorrectionFailure;

  constructor(message: string, code: CorrectionFailure) {
    super(message);
    this.name = "CorrectionError";
    this.code = code;
  }
}

/**
 * What a correctable entity must tell the service about itself.
 *
 * Registering an entity here is the whole cost of making it correctable. The
 * three functions exist because only the entity knows its own table, how to
 * canonicalise its content for the hash, and how to copy a row forward with
 * changes applied.
 */
export interface CorrectableEntity<TRow> {
  /** Table name. Also the audit label, so keep it the domain word. */
  readonly table: string;
  /** Entry kind written into the hash, e.g. "membership.granted". */
  kindOf(row: TRow): string;
  /** Deterministic content string for the hash chain. */
  contentOf(row: TRow): string;
  /**
   * Columns to write for the correction, given the original and the changes.
   * Must return every column the INSERT needs except the envelope, which the
   * service owns.
   */
  columnsFor(row: TRow, changes: Record<string, unknown>): Record<string, unknown>;
  /**
   * Entries awaiting approval must not be corrected — that would fork state.
   * They are rejected and re-entered instead, which is already an honest record
   * (Story 3.2 · 4). Entities without an approval step return false.
   */
  isPendingApproval(row: TRow): boolean;
}

export interface Actor {
  personId: string;
  displayName: string;
  role: Role;
  installId: string;
}

export interface CorrectionResult {
  correctionId: string;
  originalId: string;
  reason: string;
}

/**
 * Records a correction.
 *
 * Runs inside the caller's transaction, and takes the society lock before
 * reading, for the same reason revocation does: read-check-append sequences that
 * skip the lock decide on stale data.
 */
export async function correct<TRow extends { id: string; society_id: string; actor_id: string }>(
  tx: Queryable,
  entity: CorrectableEntity<TRow>,
  opts: {
    originalId: string;
    societyId: string;
    changes: Record<string, unknown>;
    reason: string;
    actor: Actor;
    /** "own" restricts the actor to entries they authored (staff, Flow D). */
    scope: "all" | "own";
    occurredAt?: Date;
  },
): Promise<CorrectionResult> {
  const reason = opts.reason.trim();
  if (reason.length === 0) {
    // Also a CHECK constraint. Caught here so the caller gets a sentence rather
    // than a constraint violation, and enforced there so no caller can skip it.
    throw new CorrectionError(
      "a correction must say what was wrong — that reason is the record's explanation, not paperwork",
      "reason_required",
    );
  }

  await tx.query("SELECT lock_society($1)", [opts.societyId]);

  const { rows } = await tx.query<TRow & { corrected_by: string | null }>(
    `SELECT e.*, c.id AS corrected_by
       FROM ${entity.table} e
       LEFT JOIN ${entity.table} c ON c.corrects_id = e.id
      WHERE e.id = $1 AND e.society_id = $2`,
    [opts.originalId, opts.societyId],
  );

  const original = rows[0];
  if (!original) {
    // Scoped by society, so an entry in another society is simply not found.
    throw new CorrectionError("that entry does not exist here", "not_found");
  }

  if (original.corrected_by) {
    // Corrections may chain, but each original takes one correction — otherwise
    // two rival fixes for the same mistake both claim to be current, and the
    // "honest pair" the UX promises becomes an honest crowd. Correcting the
    // correction is the supported path (Tech Design §06 critique).
    throw new CorrectionError(
      "this entry has already been corrected — correct the correction instead",
      "already_corrected",
    );
  }

  if (opts.scope === "own" && original.actor_id !== opts.actor.personId) {
    throw new CorrectionError(
      "you can only correct entries you recorded yourself",
      "not_your_entry",
    );
  }

  if (entity.isPendingApproval(original)) {
    throw new CorrectionError(
      "this entry is waiting for approval — ask the approver to reject it, then record it again",
      "pending_approval",
    );
  }

  const id = randomUUID();
  const occurredAt = (opts.occurredAt ?? new Date()).toISOString();
  const recordedAt = new Date().toISOString();

  const { rows: headRows } = await tx.query<{ head: string }>("SELECT lock_chain($1) AS head", [
    opts.societyId,
  ]);
  const prevHash = headRows[0]!.head;

  const columns = entity.columnsFor(original, opts.changes);

  const entryHash = hashEntry(
    {
      id,
      societyId: opts.societyId,
      kind: entity.kindOf(original),
      actorId: opts.actor.personId,
      actorRole: opts.actor.role,
      occurredAt,
      recordedAt,
      content: entity.contentOf({ ...original, ...columns } as TRow),
      correctsId: opts.originalId,
    },
    prevHash,
  );

  const envelope: Record<string, unknown> = {
    id,
    society_id: opts.societyId,
    actor_id: opts.actor.personId,
    actor_name: opts.actor.displayName,
    actor_role: opts.actor.role,
    install_id: opts.actor.installId,
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    corrects_id: opts.originalId,
    correct_reason: reason,
    prev_hash: prevHash,
    entry_hash: entryHash,
  };

  const all = { ...columns, ...envelope };
  const names = Object.keys(all);
  const placeholders = names.map((_, i) => `$${i + 1}`);

  await tx.query(
    `INSERT INTO ${entity.table} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    Object.values(all),
  );

  await tx.query("SELECT advance_chain($1, $2)", [opts.societyId, entryHash]);

  return { correctionId: id, originalId: opts.originalId, reason };
}

/**
 * The first registered entity. Membership events are corrected rarely — a role
 * granted to the wrong person, a seat recorded wrongly — but registering one
 * entity now is what proves the mechanism before four more depend on it.
 */
interface MembershipRow {
  id: string;
  society_id: string;
  actor_id: string;
  person_id: string;
  kind: string;
  role: string;
  committee_seat: string | null;
}

export const membershipEventEntity: CorrectableEntity<MembershipRow> = {
  table: "membership_event",
  kindOf: (row) => `membership.${row.kind}`,
  contentOf: (row) => `role=${row.role}`,
  isPendingApproval: () => false,
  columnsFor: (row, changes) => ({
    person_id: row.person_id,
    kind: row.kind,
    role: (changes["role"] as string | undefined) ?? row.role,
    committee_seat:
      "committeeSeat" in changes
        ? (changes["committeeSeat"] as string | null)
        : row.committee_seat,
    depends_on: null,
  }),
};
