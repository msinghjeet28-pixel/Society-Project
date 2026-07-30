/**
 * EVIDENCE for the race the revocation work uncovered.
 *
 * The two-committee-member guard reads a count, decides, then appends. Two
 * committee members tapping Remove at the same moment could each read "three
 * members", each pass the check, and leave the society with a single approver —
 * through the very door the guard exists to hold shut. Every payment would then
 * need a second person who does not exist.
 *
 * Note on how this is written. The obvious version — fire two revocations with
 * Promise.all and hope they collide — passes with the lock REMOVED, because the
 * event loop happens to run one sequence to completion before the other starts.
 * A regression test that cannot fail on the regression is decoration, so this
 * drives two connections through the interleaving explicitly: both transactions
 * are open, and the second attempts its check while the first is uncommitted.
 *
 * Without lock_society() (migration 0003) the second read sees the stale count
 * and both succeed. With it, the second blocks until the first commits, then
 * reads the true count and refuses.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";

import { closePool, inTransaction, pool } from "../src/db.ts";
import { grantRole, MembershipError, revokeRole } from "../src/auth/membership.ts";
import { ownerClient, resetWorld, seedPerson, seedSociety } from "./helpers/db.ts";

let owner: pg.Client;
let societyId: string;
let committee: string[];

const actor = () => ({ id: committee[0]!, name: "Founder", role: "committee" as const });

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
  await seedSociety(owner, { id: societyId, name: "Race Test CGHS" });

  committee = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, personId] of committee.entries()) {
    await seedPerson(owner, { id: personId, societyId, name: `Committee ${i + 1}` });
    await inTransaction((tx) =>
      grantRole(tx, {
        societyId, personId, role: "committee",
        actor: { id: committee[0]!, name: "Founder", role: "committee" },
        installId: randomUUID(),
      }),
    );
  }
});

async function committeeCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(`SELECT active_committee_count($1) AS n`, [
    societyId,
  ]);
  return rows[0]!.n;
}

it("never lets two overlapping revocations drop the committee below two", async () => {
  expect(await committeeCount()).toBe(3);

  const first = await pool.connect();
  const second = await pool.connect();

  try {
    // Transaction A: removes member 2 and holds its transaction open.
    await first.query("BEGIN");
    await revokeRole(first, {
      societyId, personId: committee[1]!, role: "committee",
      actor: actor(), installId: randomUUID(),
    });

    // Transaction B starts while A is still uncommitted. This is the moment the
    // bug lives in: without the society lock, B's count read returns the stale
    // 3 and B proceeds to remove member 3 as well.
    await second.query("BEGIN");
    const secondAttempt = revokeRole(second, {
      societyId, personId: committee[2]!, role: "committee",
      actor: actor(), installId: randomUUID(),
    });

    // Give B a moment to reach its check. With the lock it is now blocked; the
    // commit below is what releases it.
    const settledEarly = await Promise.race([
      secondAttempt.then(() => "completed").catch(() => "refused"),
      new Promise<string>((r) => setTimeout(() => r("blocked"), 150)),
    ]);

    await first.query("COMMIT");

    let outcome: "completed" | "refused";
    try {
      await secondAttempt;
      await second.query("COMMIT");
      outcome = "completed";
    } catch (err) {
      await second.query("ROLLBACK");
      expect(err).toBeInstanceOf(MembershipError);
      expect((err as MembershipError).code).toBe("last_committee_member");
      outcome = "refused";
    }

    // The lock is what produces "blocked then refused". If B had sailed through
    // its check on stale data, this would be "completed".
    expect(settledEarly).toBe("blocked");
    expect(outcome).toBe("refused");

    // The floor holds.
    expect(await committeeCount()).toBe(2);
  } finally {
    first.release();
    second.release();
  }
});

it("keeps the chain unforked through contended appends", async () => {
  await Promise.allSettled(
    committee.slice(1).map((personId) =>
      inTransaction((tx) =>
        revokeRole(tx, {
          societyId, personId, role: "committee",
          actor: actor(), installId: randomUUID(),
        }),
      ),
    ),
  );

  const { rows } = await owner.query<{ prev_hash: string }>(
    `SELECT prev_hash FROM membership_event WHERE society_id = $1
      ORDER BY recorded_at, entry_hash`,
    [societyId],
  );

  // No two entries may claim the same parent.
  expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(rows.length);
});
