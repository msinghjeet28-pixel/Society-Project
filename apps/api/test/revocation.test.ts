/**
 * EVIDENCE for Story 1.3's edge case — "a committee member revokes the role
 * instantly; revocation takes effect on the server immediately, independent of
 * the device."
 *
 * The scenario the PRD is really describing: Ramesh leaves, possibly holding
 * his own phone, possibly with the app still open on two devices. The
 * committee taps Remove. Nothing he holds may work a moment later.
 *
 * This is also the test that proves the membership-version mechanism, which is
 * the only reason revocation does not have to wait for a token to expire.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";

import { buildApp } from "../src/app.ts";
import { closePool, inTransaction } from "../src/db.ts";
import { grantRole } from "../src/auth/membership.ts";
import { signAccessToken } from "../src/auth/token.ts";
import { membershipVersion } from "../src/auth/membership.ts";
import { ownerClient, resetWorld, seedPerson, seedSociety } from "./helpers/db.ts";

let app: FastifyInstance;
let owner: pg.Client;

let societyId: string;
let treasurerId: string;
let secretaryId: string;
let presidentId: string;
let staffId: string;

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await resetWorld(owner);
  await owner.end();
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetWorld(owner);

  societyId = randomUUID();
  await seedSociety(owner, { id: societyId, name: "Harmony CGHS" });

  treasurerId = randomUUID();
  secretaryId = randomUUID();
  presidentId = randomUUID();
  staffId = randomUUID();

  await seedPerson(owner, { id: treasurerId, societyId, name: "Vikram Mehta", phone: "+919810000001" });
  await seedPerson(owner, { id: secretaryId, societyId, name: "Sudha Menon", phone: "+919810000002" });
  await seedPerson(owner, { id: presidentId, societyId, name: "R. K. Bedekar", phone: "+919810000003" });
  await seedPerson(owner, { id: staffId, societyId, name: "Ramesh Kumar", phone: "+919810000004" });

  const founder = { id: treasurerId, name: "Vikram Mehta", role: "committee" as const };
  await inTransaction(async (tx) => {
    for (const [personId, role, seat] of [
      [treasurerId, "committee", "treasurer"],
      [secretaryId, "committee", "secretary"],
      [presidentId, "committee", "president"],
      [staffId, "staff", null],
    ] as const) {
      await grantRole(tx, {
        societyId, personId, role, committeeSeat: seat,
        actor: founder, installId: randomUUID(),
      });
    }
  });
});

/** A token as the real login flow would mint it. */
async function tokenFor(personId: string, role: string, installId = randomUUID()): Promise<string> {
  const mv = await membershipVersion(societyId);
  return signAccessToken({ sub: personId, soc: societyId, role, mv, iid: installId });
}

describe("revocation is instant and device-independent", () => {
  it("kills a session mid-flight, on every device the person holds", async () => {
    // Ramesh is signed in on two devices — his own phone and a society tablet.
    const phone = await tokenFor(staffId, "staff", randomUUID());
    const tablet = await tokenFor(staffId, "staff", randomUUID());

    // Both work.
    for (const token of [phone, tablet]) {
      const res = await app.inject({
        method: "GET", url: "/people", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    }

    // Sudha removes him.
    const secretary = await tokenFor(secretaryId, "committee");
    const revoke = await app.inject({
      method: "POST",
      url: `/people/${staffId}/revoke`,
      headers: { authorization: `Bearer ${secretary}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ revoked: true });

    // Neither device works now. No waiting for a token to expire.
    for (const [label, token] of [["phone", phone], ["tablet", tablet]] as const) {
      const res = await app.inject({
        method: "GET", url: "/people", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${label} should be locked out`).toBe(401);
    }
  });

  it("ends refresh sessions too, so the client cannot quietly renew", async () => {
    const { rows: before } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM refresh_token WHERE person_id = $1 AND revoked_at IS NULL`,
      [staffId],
    );
    // Give Ramesh a live refresh row.
    await owner.query(
      `INSERT INTO refresh_token (id, token_hash, person_id, society_id, install_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '90 days')`,
      [randomUUID(), Buffer.from(randomUUID()), staffId, societyId, randomUUID()],
    );

    const secretary = await tokenFor(secretaryId, "committee");
    const res = await app.inject({
      method: "POST", url: `/people/${staffId}/revoke`,
      headers: { authorization: `Bearer ${secretary}` },
    });
    expect(res.json().sessionsEnded).toBeGreaterThanOrEqual(1);

    const { rows: after } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM refresh_token WHERE person_id = $1 AND revoked_at IS NULL`,
      [staffId],
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it("leaves the revoked person's past entries in the record, under their name", async () => {
    const secretary = await tokenFor(secretaryId, "committee");
    await app.inject({
      method: "POST", url: `/people/${staffId}/revoke`,
      headers: { authorization: `Bearer ${secretary}` },
    });

    const { rows } = await owner.query<{ actor_name: string; kind: string; role: string }>(
      `SELECT actor_name, kind, role FROM membership_event
        WHERE society_id = $1 AND person_id = $2 ORDER BY recorded_at`,
      [societyId, staffId],
    );

    // The grant is still there; the revocation is a new entry beside it.
    expect(rows.map((r) => r.kind)).toEqual(["granted", "revoked"]);
    // And the revocation records who did it.
    expect(rows[1]!.actor_name).toBe("Sudha Menon");
    // The revocation names the role actually held, not one the caller guessed.
    expect(rows[1]!.role).toBe("staff");
  });
});

describe("the two-committee-member guard (Flow C4e)", () => {
  it("refuses the removal that would leave one approver", async () => {
    const president = await tokenFor(presidentId, "committee");

    // Three committee members; removing one is fine.
    const first = await app.inject({
      method: "POST", url: `/people/${treasurerId}/revoke`,
      headers: { authorization: `Bearer ${president}` },
    });
    expect(first.statusCode).toBe(200);

    // Two left. Removing another would leave a single approver, so it is
    // refused — the flow protects the society from disabling itself.
    const stillPresident = await tokenFor(presidentId, "committee");
    const second = await app.inject({
      method: "POST", url: `/people/${secretaryId}/revoke`,
      headers: { authorization: `Bearer ${stillPresident}` },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "last_committee_member" });
    expect(second.json().error).toMatch(/every payment needs two/i);
  });

  it("still allows removing staff when the committee is at its minimum", async () => {
    const president = await tokenFor(presidentId, "committee");
    await app.inject({
      method: "POST", url: `/people/${treasurerId}/revoke`,
      headers: { authorization: `Bearer ${president}` },
    });

    // Committee is at two now; staff removal is unaffected by the guard.
    const stillPresident = await tokenFor(presidentId, "committee");
    const res = await app.inject({
      method: "POST", url: `/people/${staffId}/revoke`,
      headers: { authorization: `Bearer ${stillPresident}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("who may revoke", () => {
  it("refuses staff, who cannot manage roles at all", async () => {
    const staff = await tokenFor(staffId, "staff");
    const res = await app.inject({
      method: "POST", url: `/people/${secretaryId}/revoke`,
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses the accountant, who may read everything and change nothing", async () => {
    const accountantId = randomUUID();
    await seedPerson(owner, { id: accountantId, societyId, name: "Prakash Joshi" });
    await inTransaction((tx) =>
      grantRole(tx, {
        societyId, personId: accountantId, role: "accountant",
        actor: { id: treasurerId, name: "Vikram Mehta", role: "committee" },
        installId: randomUUID(),
      }),
    );

    const accountant = await tokenFor(accountantId, "accountant");
    const res = await app.inject({
      method: "POST", url: `/people/${staffId}/revoke`,
      headers: { authorization: `Bearer ${accountant}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("stale tokens after any role change", () => {
  it("expires everyone's token when the society's roles change", async () => {
    // The version is per society, so adding a person invalidates outstanding
    // tokens. The client re-authenticates silently; the cost is one round trip,
    // and the benefit is that no stale role claim can ever be honoured.
    const staff = await tokenFor(staffId, "staff");
    expect(
      (await app.inject({ method: "GET", url: "/people", headers: { authorization: `Bearer ${staff}` } }))
        .statusCode,
    ).toBe(200);

    const treasurer = await tokenFor(treasurerId, "committee");
    await app.inject({
      method: "POST", url: "/people",
      headers: { authorization: `Bearer ${treasurer}` },
      payload: { name: "New Watchman", role: "staff" },
    });

    const after = await app.inject({
      method: "GET", url: "/people", headers: { authorization: `Bearer ${staff}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().reason).toBe("roles changed");
  });
});
