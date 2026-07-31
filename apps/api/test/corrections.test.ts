/**
 * EVIDENCE for Story 1.4 and Tech Design §06 — the honest pair.
 *
 * "No user, including us as the vendor, can edit or delete a submitted entry. A
 * correction creates a new entry linked to the original, showing who corrected
 * it, when, and the stated reason. Both remain visible in the trail."
 *
 * The UX calls the preview screen the trust moment: users accept immutability
 * once they can see, before committing, that correcting is not confessing. These
 * tests are that promise stated in assertions — the original untouched byte for
 * byte, the correction beside it, both under their author's name, forever.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";

import { closePool, inTransaction } from "../src/db.ts";
import { grantRole } from "../src/auth/membership.ts";
import {
  CorrectionError, correct, membershipEventEntity,
} from "../src/ledger/corrections.ts";
import { verifyChain, type ChainLink } from "@sr/envelope/core";
import { ownerClient, resetWorld, seedPerson, seedSociety } from "./helpers/db.ts";

let owner: pg.Client;
let societyId: string;
let treasurerId: string;
let staffId: string;
let staffGrantId: string;

const treasurer = () => ({
  personId: treasurerId,
  displayName: "Vikram Mehta",
  role: "committee" as const,
  installId: randomUUID(),
});

const staff = () => ({
  personId: staffId,
  displayName: "Santosh Yadav",
  role: "staff" as const,
  installId: randomUUID(),
});

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

beforeEach(async () => {
  await resetWorld(owner);
  societyId = randomUUID();
  await seedSociety(owner, { id: societyId, name: "Harmony CGHS" });

  treasurerId = randomUUID();
  staffId = randomUUID();
  await seedPerson(owner, { id: treasurerId, societyId, name: "Vikram Mehta" });
  await seedPerson(owner, { id: staffId, societyId, name: "Santosh Yadav" });

  const actor = { id: treasurerId, name: "Vikram Mehta", role: "committee" as const };
  await inTransaction(async (tx) => {
    await grantRole(tx, {
      societyId, personId: treasurerId, role: "committee",
      committeeSeat: "treasurer", actor, installId: randomUUID(),
    });
    // The entry under correction throughout: Santosh granted staff. Suppose he
    // should have been recorded as accountant.
    staffGrantId = await grantRole(tx, {
      societyId, personId: staffId, role: "staff", actor, installId: randomUUID(),
    });
  });
});

async function snapshotOf(id: string) {
  const { rows } = await owner.query(
    `SELECT * FROM membership_event WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function loadChain(): Promise<ChainLink[]> {
  const { rows } = await owner.query<{
    id: string; society_id: string; kind: string; actor_id: string; actor_role: string;
    occurred_at: Date; recorded_at: Date; role: string; corrects_id: string | null;
    prev_hash: string; entry_hash: string;
  }>(
    `SELECT id, society_id, kind, actor_id, actor_role, occurred_at, recorded_at,
            role, corrects_id, prev_hash, entry_hash
       FROM membership_event WHERE society_id = $1`,
    [societyId],
  );
  return rows.map((r) => ({
    id: r.id,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    entry: {
      id: r.id,
      societyId: r.society_id,
      kind: `membership.${r.kind}`,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      occurredAt: r.occurred_at.toISOString(),
      recordedAt: r.recorded_at.toISOString(),
      content: `role=${r.role}`,
      correctsId: r.corrects_id ?? undefined,
    },
  }));
}

describe("the original is untouched", () => {
  it("leaves every column of the corrected entry exactly as it was", async () => {
    const before = await snapshotOf(staffGrantId);

    await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId,
        societyId,
        changes: { role: "accountant" },
        reason: "Recorded as staff by mistake — Prakash asked for him on the books.",
        actor: treasurer(),
        scope: "all",
      }),
    );

    expect(await snapshotOf(staffGrantId)).toEqual(before);
  });

  it("derives 'corrected' rather than writing it onto the original", async () => {
    await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "accountant" },
        reason: "Wrong role recorded at setup.",
        actor: treasurer(), scope: "all",
      }),
    );

    // Nothing on the row says "corrected" — the view computes it from the pair.
    const { rows } = await owner.query<{ is_corrected: boolean; correction_reason: string }>(
      `SELECT is_corrected, correction_reason FROM membership_event_current WHERE id = $1`,
      [staffGrantId],
    );
    expect(rows[0]!.is_corrected).toBe(true);
    expect(rows[0]!.correction_reason).toBe("Wrong role recorded at setup.");
  });
});

describe("the correction stands beside it", () => {
  it("records who corrected it, when, and why", async () => {
    const result = await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "accountant" },
        reason: "Should have been accountant — he keeps the books, not the building.",
        actor: treasurer(), scope: "all",
      }),
    );

    const correction = await snapshotOf(result.correctionId);
    expect(correction["corrects_id"]).toBe(staffGrantId);
    expect(correction["correct_reason"]).toMatch(/keeps the books/);
    expect(correction["actor_name"]).toBe("Vikram Mehta");
    expect(correction["actor_role"]).toBe("committee");
    expect(correction["role"]).toBe("accountant");
    expect(correction["recorded_at"]).toBeInstanceOf(Date);
  });

  it("keeps both entries in the trail, forever", async () => {
    await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "accountant" },
        reason: "Wrong role.",
        actor: treasurer(), scope: "all",
      }),
    );

    const { rows } = await owner.query<{ id: string; role: string; corrects_id: string | null }>(
      `SELECT id, role, corrects_id FROM membership_event
        WHERE person_id = $1 ORDER BY recorded_at`,
      [staffId],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.role).toBe("staff");        // what was recorded
    expect(rows[1]!.role).toBe("accountant");   // what it should have been
    expect(rows[1]!.corrects_id).toBe(rows[0]!.id);
  });

  it("extends the hash chain rather than rewriting it", async () => {
    const before = await loadChain();

    await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "accountant" },
        reason: "Wrong role.",
        actor: treasurer(), scope: "all",
      }),
    );

    const after = await loadChain();
    expect(after).toHaveLength(before.length + 1);
    expect(verifyChain(after)).toMatchObject({ ok: true });
  });
});

describe("the rules the design critique produced", () => {
  it("refuses a correction with no reason, before the constraint has to", async () => {
    await expect(
      inTransaction((tx) =>
        correct(tx, membershipEventEntity, {
          originalId: staffGrantId, societyId,
          changes: { role: "accountant" },
          reason: "   ",
          actor: treasurer(), scope: "all",
        }),
      ),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("enforces the mandatory reason in the schema too, not only in the service", async () => {
    // Belt and braces on purpose: the reason is the record's explanation of
    // itself, and a future caller that forgets it must fail at the database.
    await expect(
      owner.query(
        `INSERT INTO membership_event
           (id, society_id, person_id, kind, role, actor_id, actor_name, actor_role,
            install_id, occurred_at, recorded_at, prev_hash, entry_hash, corrects_id)
         VALUES ($1,$2,$3,'granted','accountant',$4,'X','committee',$5,now(),now(),
                 repeat('0',64), repeat('a',64), $6)`,
        [randomUUID(), societyId, staffId, treasurerId, randomUUID(), staffGrantId],
      ),
    ).rejects.toThrow(/correction_needs_reason/);
  });

  it("allows a correction to be corrected, and refuses a second rival fix", async () => {
    const first = await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "accountant" },
        reason: "First attempt — thought he was the accountant.",
        actor: treasurer(), scope: "all",
      }),
    );

    // A rival correction of the SAME original: refused. Two fixes both claiming
    // to be current turns the honest pair into an honest crowd.
    await expect(
      inTransaction((tx) =>
        correct(tx, membershipEventEntity, {
          originalId: staffGrantId, societyId,
          changes: { role: "committee" },
          reason: "No, committee.",
          actor: treasurer(), scope: "all",
        }),
      ),
    ).rejects.toMatchObject({ code: "already_corrected" });

    // Correcting the correction: allowed, and the chain stays legible.
    const second = await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: first.correctionId, societyId,
        changes: { role: "committee" },
        reason: "He was voted onto the committee at the AGM.",
        actor: treasurer(), scope: "all",
      }),
    );

    const { rows } = await owner.query<{ id: string; corrects_id: string | null; role: string }>(
      `SELECT id, corrects_id, role FROM membership_event
        WHERE person_id = $1 ORDER BY recorded_at`,
      [staffId],
    );
    expect(rows).toHaveLength(3);
    expect(rows[1]!.corrects_id).toBe(staffGrantId);
    expect(rows[2]!.corrects_id).toBe(first.correctionId);
    expect(second.correctionId).toBe(rows[2]!.id);
  });

  it("refuses to correct an entry that belongs to another society", async () => {
    const otherSociety = randomUUID();
    await seedSociety(owner, { id: otherSociety, name: "Riverside CGHS" });

    await expect(
      inTransaction((tx) =>
        correct(tx, membershipEventEntity, {
          originalId: staffGrantId,
          societyId: otherSociety,
          changes: { role: "accountant" },
          reason: "Not mine to correct.",
          actor: treasurer(), scope: "all",
        }),
      ),
      // not_found rather than forbidden: the query is society-scoped, so from
      // Riverside's side the entry genuinely does not exist.
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("staff may correct their own entries, and only their own (Flow D)", () => {
  it("lets staff correct what they recorded", async () => {
    // An entry authored by Santosh himself.
    const own = await inTransaction((tx) =>
      grantRole(tx, {
        societyId, personId: staffId, role: "member",
        actor: { id: staffId, name: "Santosh Yadav", role: "staff" },
        installId: randomUUID(),
      }),
    );

    await expect(
      inTransaction((tx) =>
        correct(tx, membershipEventEntity, {
          originalId: own, societyId,
          changes: { role: "staff" },
          reason: "Tapped the wrong role.",
          actor: staff(), scope: "own",
        }),
      ),
    ).resolves.toMatchObject({ originalId: own });
  });

  it("refuses staff correcting someone else's entry", async () => {
    // staffGrantId was recorded by the treasurer.
    await expect(
      inTransaction((tx) =>
        correct(tx, membershipEventEntity, {
          originalId: staffGrantId, societyId,
          changes: { role: "committee" },
          reason: "Promoting myself.",
          actor: staff(), scope: "own",
        }),
      ),
    ).rejects.toMatchObject({ code: "not_your_entry" });
  });

  it("still refuses even when the message would be tempting to trust", async () => {
    const err = await inTransaction((tx) =>
      correct(tx, membershipEventEntity, {
        originalId: staffGrantId, societyId,
        changes: { role: "committee" },
        reason: "Approved verbally by the president.",
        actor: staff(), scope: "own",
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CorrectionError);
    // And nothing was written.
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM membership_event WHERE corrects_id IS NOT NULL`,
    );
    expect(rows[0]!.n).toBe("0");
  });
});
