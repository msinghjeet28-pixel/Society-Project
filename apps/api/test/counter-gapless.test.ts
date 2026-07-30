/**
 * EVIDENCE for Tech Design §05 — "the concurrency proof".
 *
 * 100 concurrent receipt issuances against one society, 20% of the
 * transactions aborted mid-flight. The issued numbers must be exactly 1…80:
 * no gaps (an auditor's first question), no duplicates (two receipts claiming
 * one number is the severest bug class in the PRD).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { closeTestPool, ownerClient, resetWorld, seedSociety, withAppRole } from "./helpers/db.ts";

let owner: pg.Client;
let societyId: string;

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
});

beforeEach(async () => {
  // Fresh world and a fresh society per test: the second assertion below must
  // not depend on the first test having run.
  await resetWorld(owner);
  societyId = randomUUID();
  await seedSociety(owner, { id: societyId, name: "Counter Test", flats: 30 });
});

afterAll(async () => {
  await owner.end();
  await closeTestPool();
});

/** Issue a number; `abort` rolls back, which must roll the number back too. */
async function issue(abort: boolean): Promise<number | null> {
  return withAppRole(async (c) => {
    await c.query("BEGIN");
    const { rows } = await c.query<{ n: string }>("SELECT issue_number($1,'receipt') AS n", [
      societyId,
    ]);
    if (abort) {
      await c.query("ROLLBACK");
      return null;
    }
    await c.query("COMMIT");
    return Number(rows[0]!.n);
  });
}

it("issues gapless, duplicate-free numbers under concurrency with rollbacks", async () => {
  // Deterministic 20% abort pattern — every 5th attempt — so a failure is
  // reproducible rather than a flake nobody can chase.
  const attempts = Array.from({ length: 100 }, (_, i) => i % 5 === 4);

  const issued = (await Promise.all(attempts.map((abort) => issue(abort)))).filter(
    (n): n is number => n !== null,
  );

  expect(issued).toHaveLength(80);

  const sorted = [...issued].sort((a, b) => a - b);
  expect(sorted).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));

  expect(new Set(issued).size).toBe(80);
}, 30_000);

it("keeps the two counters independent — issuing receipts never moves complaints", async () => {
  await issue(false);
  await issue(false);

  const { rows } = await owner.query<{ kind: string; next_value: string }>(
    "SELECT kind, next_value FROM counter WHERE society_id = $1 ORDER BY kind",
    [societyId],
  );
  expect(rows).toEqual([
    { kind: "complaint", next_value: "1" },
    { kind: "receipt", next_value: "3" },
  ]);
});
