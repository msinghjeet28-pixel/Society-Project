import { randomUUID } from "node:crypto";
import type { Role } from "@sr/envelope/core";
import { hashEntry } from "@sr/envelope/core";
import { MIN_COMMITTEE_MEMBERS } from "@sr/policy";
import type { Queryable } from "../db.ts";
import { pool } from "../db.ts";

/**
 * Memberships (Stories 1.2, 1.3).
 *
 * Roles are an event stream; "current role" is a projection over it. That is
 * what makes revocation an append rather than an edit, and what makes "who
 * added whom, as what, when" answerable without a separate audit table.
 */

export interface Membership {
  societyId: string;
  societyName: string;
  personId: string;
  displayName: string;
  role: Role;
  committeeSeat: string | null;
}

/**
 * Every society this phone number can act in.
 *
 * A number may hold roles in several societies — Prakash the accountant works
 * across nine (Story 1.2 · 3) — so this returns a list and the caller decides
 * between going straight in and showing the picker.
 */
export async function membershipsForPhone(phone: string): Promise<Membership[]> {
  const { rows } = await pool.query<{
    society_id: string;
    society_name: string;
    person_id: string;
    display_name: string;
    role: Role;
    committee_seat: string | null;
  }>(
    `SELECT ma.society_id, s.name AS society_name, ma.person_id,
            p.display_name, ma.role, ma.committee_seat
       FROM membership_active ma
       JOIN person  p ON p.id = ma.person_id
       JOIN society s ON s.id = ma.society_id
      WHERE p.phone_e164 = $1
      ORDER BY s.name`,
    [phone],
  );

  return rows.map((r) => ({
    societyId: r.society_id,
    societyName: r.society_name,
    personId: r.person_id,
    displayName: r.display_name,
    role: r.role,
    committeeSeat: r.committee_seat,
  }));
}

export async function membershipVersion(societyId: string): Promise<number> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version::text FROM membership_version WHERE society_id = $1`,
    [societyId],
  );
  if (!rows[0]) throw new Error(`no membership_version row for society ${societyId}`);
  return Number(rows[0].version);
}

/** Confirms a person is still active in a society, freshly, server-side. */
export async function activeMembership(
  personId: string,
  societyId: string,
): Promise<{ role: Role; displayName: string } | null> {
  const { rows } = await pool.query<{ role: Role; display_name: string }>(
    `SELECT ma.role, p.display_name
       FROM membership_active ma
       JOIN person p ON p.id = ma.person_id
      WHERE ma.person_id = $1 AND ma.society_id = $2`,
    [personId, societyId],
  );
  const row = rows[0];
  return row ? { role: row.role, displayName: row.display_name } : null;
}

export type MembershipFailure = "last_committee_member" | "not_a_member" | "already_has_role";

export class MembershipError extends Error {
  // Explicit assignment, not a parameter property — see the note in otp.ts.
  readonly code: MembershipFailure;

  constructor(message: string, code: MembershipFailure) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
  }
}

interface GrantOpts {
  societyId: string;
  personId: string;
  role: Role;
  committeeSeat?: string | null;
  actor: { id: string; name: string; role: Role };
  installId: string;
  occurredAt?: Date;
}

/**
 * Appends a membership event and bumps the society's membership version, in
 * one transaction. The version bump is what makes revocation effective within
 * seconds on every device (Arch §07).
 */
async function appendMembershipEvent(
  tx: Queryable,
  kind: "granted" | "revoked",
  opts: GrantOpts,
): Promise<string> {
  const id = randomUUID();
  const occurredAt = (opts.occurredAt ?? new Date()).toISOString();

  const { rows: headRows } = await tx.query<{ head: string }>("SELECT lock_chain($1) AS head", [
    opts.societyId,
  ]);
  const prevHash = headRows[0]!.head;
  const recordedAt = new Date().toISOString();

  const entryHash = hashEntry(
    {
      id,
      societyId: opts.societyId,
      kind: `membership.${kind}`,
      actorId: opts.actor.id,
      actorRole: opts.actor.role,
      occurredAt,
      recordedAt,
      content: `role=${opts.role}`,
    },
    prevHash,
  );

  await tx.query(
    `INSERT INTO membership_event
       (id, society_id, person_id, kind, role, committee_seat, actor_id, actor_name,
        actor_role, install_id, occurred_at, recorded_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, opts.societyId, opts.personId, kind, opts.role, opts.committeeSeat ?? null,
      opts.actor.id, opts.actor.name, opts.actor.role, opts.installId,
      occurredAt, recordedAt, prevHash, entryHash,
    ],
  );

  await tx.query("SELECT advance_chain($1,$2)", [opts.societyId, entryHash]);
  await tx.query(
    `UPDATE membership_version SET version = version + 1 WHERE society_id = $1`,
    [opts.societyId],
  );

  return id;
}

export async function grantRole(tx: Queryable, opts: GrantOpts): Promise<string> {
  return appendMembershipEvent(tx, "granted", opts);
}

/**
 * Revokes a role. Takes effect on the server immediately, independent of the
 * device (Story 1.3 edge case).
 *
 * Refuses to leave the society with fewer than two committee members: every
 * payment needs a second person, so the flow protects the society from
 * disabling itself (Flow C4e). The guard lives here rather than in the screen
 * that happens to ask, so no future caller can route around it.
 */
export async function revokeRole(tx: Queryable, opts: GrantOpts): Promise<string> {
  // Take the society lock BEFORE reading the committee count. Without this,
  // two concurrent revocations both read "three committee members", both
  // proceed, and the society is left with one approver — through the very door
  // the guard below exists to hold shut. A row lock cannot substitute:
  // membership_active is a DISTINCT ON projection and Postgres refuses
  // FOR SHARE on those. The append later re-takes the same lock, which is a
  // no-op within one transaction.
  await tx.query("SELECT lock_society($1)", [opts.societyId]);

  const { rows } = await tx.query<{ role: Role }>(
    `SELECT role FROM membership_active WHERE society_id = $1 AND person_id = $2`,
    [opts.societyId, opts.personId],
  );
  const current = rows[0];
  if (!current) {
    throw new MembershipError("that person has no active role here", "not_a_member");
  }

  if (current.role === "committee") {
    const { rows: countRows } = await tx.query<{ n: number }>(
      `SELECT active_committee_count($1) AS n`,
      [opts.societyId],
    );
    if (countRows[0]!.n <= MIN_COMMITTEE_MEMBERS) {
      throw new MembershipError(
        "Add another committee member first — every payment needs two.",
        "last_committee_member",
      );
    }
  }

  // Revoke the role they actually hold, not the one the caller guessed.
  return appendMembershipEvent(tx, "revoked", { ...opts, role: current.role });
}

/** All sessions for a person in a society, killed. */
export async function revokeRefreshTokens(
  tx: Queryable,
  personId: string,
  societyId: string,
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE refresh_token SET revoked_at = now()
      WHERE person_id = $1 AND society_id = $2 AND revoked_at IS NULL`,
    [personId, societyId],
  );
  return rowCount ?? 0;
}
