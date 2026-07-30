/**
 * EVIDENCE for Tech Design §02 — "the test that tries to cheat".
 *
 * Asserts all four immutability layers, including the concurrency fork the
 * §02 critique found. This test connects as the app role AND as the migration
 * owner, because "no user, including us as the vendor" is only proven if the
 * privileged path is attacked too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { hashEntry, verifyChain, type ChainLink } from "@sr/envelope/core";
import { closeTestPool, ownerClient, resetWorld, seedPerson, seedSociety, withAppRole } from "./helpers/db.ts";

// app_rw is NOLOGIN; SET ROLE carries the same privilege restrictions as
// connecting as that role, so these tests attack what actually ships.
let owner: pg.Client;
let societyId: string;
const asAppRole = withAppRole;

/** Append a membership event through the chain lock, as the app would. */
async function append(
  // Anything that can issue SQL: a pooled client from withAppRole, or a plain
  // one. Narrowing this to pg.Client is what broke when app-role connections
  // moved to a pool.
  client: Pick<pg.PoolClient, "query">,
  opts: { societyId: string; personId: string; kind: "granted" | "revoked" },
): Promise<string> {
  const id = randomUUID();
  const occurredAt = new Date().toISOString();

  await client.query("BEGIN");
  const { rows } = await client.query<{ head: string }>("SELECT lock_chain($1) AS head", [
    opts.societyId,
  ]);
  const prevHash = rows[0]!.head;

  const recordedAt = new Date().toISOString();
  const entryHash = hashEntry(
    {
      id,
      societyId: opts.societyId,
      kind: `membership.${opts.kind}`,
      actorId: opts.personId,
      actorRole: "committee",
      occurredAt,
      recordedAt,
      content: `role=staff`,
    },
    prevHash,
  );

  await client.query(
    `INSERT INTO membership_event
       (id, society_id, person_id, kind, role, actor_id, actor_name, actor_role,
        install_id, occurred_at, recorded_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,'staff',$3,'Test Actor','committee',$5,$6,$7,$8,$9)`,
    [id, opts.societyId, opts.personId, opts.kind, randomUUID(), occurredAt, recordedAt, prevHash, entryHash],
  );
  await client.query("SELECT advance_chain($1, $2)", [opts.societyId, entryHash]);
  await client.query("COMMIT");
  return id;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  await resetWorld(owner);

  societyId = randomUUID();
  await seedSociety(owner, { id: societyId });
});

afterAll(async () => {
  // Deliberately no reset here. Fixtures are wiped at the START of a file's
  // work, never at the end: a teardown that truncates shared tables can clobber
  // another file's fixtures, which is exactly how CI went red while local passed.
  await owner.end();
  await closeTestPool();
});

describe("layer 2 · database privileges", () => {
  it("refuses UPDATE on a ledger table as app_rw", async () => {
    const personId = randomUUID();
    await seedPerson(owner, { id: personId, societyId, name: "Ramesh" });
    const entryId = await asAppRole((c) => append(c, { societyId, personId, kind: "granted" }));

    await expect(
      asAppRole((c) => c.query("UPDATE membership_event SET role = 'committee' WHERE id = $1", [entryId])),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
  });

  it("refuses DELETE on a ledger table as app_rw", async () => {
    await expect(
      asAppRole((c) => c.query("DELETE FROM membership_event WHERE society_id = $1", [societyId])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("layer 3 · triggers catch the privileged session", () => {
  it("refuses UPDATE even as the migration owner", async () => {
    // This is the vendor half of the claim: our own superuser-ish connection
    // must also fail, or "including us" is marketing.
    await expect(
      owner.query("UPDATE membership_event SET role = 'committee' WHERE society_id = $1", [societyId]),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses DELETE even as the migration owner", async () => {
    await expect(
      owner.query("DELETE FROM membership_event WHERE society_id = $1 AND kind = 'granted'", [
        societyId,
      ]),
    ).rejects.toThrow(/append-only/i);
  });
});

describe("layer 4 · the hash chain detects tampering", () => {
  it("verifies a clean chain", async () => {
    const links = await loadChain(societyId);
    expect(links.length).toBeGreaterThan(0);
    expect(verifyChain(links)).toMatchObject({ ok: true });
  });

  it("reports the exact row when content is altered", async () => {
    const links = await loadChain(societyId);
    const target = links[0]!;
    // Simulate an alteration that bypassed every layer above.
    const tampered: ChainLink[] = links.map((l) =>
      l.id === target.id ? { ...l, entry: { ...l.entry, content: "role=committee" } } : l,
    );
    const verdict = verifyChain(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.brokenAt).toBe(target.id);
      expect(verdict.reason).toMatch(/content altered/);
    }
  });
});

describe("layer 4 · concurrency (the fork the critique found)", () => {
  it("50 concurrent appends produce one unforked chain", async () => {
    const personId = randomUUID();
    await seedPerson(owner, { id: personId, societyId, name: "Concurrent Actor" });

    const before = (await loadChain(societyId)).length;

    await Promise.all(
      Array.from({ length: 50 }, () =>
        asAppRole((c) => append(c, { societyId, personId, kind: "granted" })),
      ),
    );

    const links = await loadChain(societyId);
    expect(links).toHaveLength(before + 50);

    // Without pg_advisory_xact_lock in lock_chain(), this assertion fails:
    // several rows share a prev_hash and the chain forks.
    const prevHashes = new Set(links.map((l) => l.prevHash));
    expect(prevHashes.size).toBe(links.length);

    expect(verifyChain(links)).toMatchObject({ ok: true });
  });
});

async function loadChain(society: string): Promise<ChainLink[]> {
  const { rows } = await owner.query<{
    id: string;
    society_id: string;
    kind: string;
    actor_id: string;
    actor_role: string;
    occurred_at: Date;
    recorded_at: Date;
    prev_hash: string;
    entry_hash: string;
  }>(
    `SELECT id, society_id, kind, actor_id, actor_role, occurred_at, recorded_at, prev_hash, entry_hash
       FROM membership_event WHERE society_id = $1 ORDER BY recorded_at, entry_hash`,
    [society],
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
      content: "role=staff",
    },
  }));
}
