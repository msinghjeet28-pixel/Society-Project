/**
 * EVIDENCE for Story 1.2 · criteria 3 — "one person holding roles in multiple
 * societies can switch between them."
 *
 * Prakash the accountant works across nine societies (PRD §3). One phone
 * number, several societies, a different role in each. The login flow must
 * offer the picker (Flow B4) rather than guessing, and each society's session
 * must be scoped to that society alone — an accountant trusted with Harmony's
 * books has no business reading Riverside's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";
process.env["OTP_CHANNEL"] ??= "manual";

import { buildApp } from "../src/app.ts";
import { closePool, inTransaction, pool } from "../src/db.ts";
import { grantRole, membershipsForPhone, revokeRole } from "../src/auth/membership.ts";
import { issueChallenge } from "../src/auth/otp.ts";
import { verifyAccessToken } from "../src/auth/token.ts";
import { ownerClient, resetWorld, seedPerson, seedSociety } from "./helpers/db.ts";

let app: FastifyInstance;
let owner: pg.Client;

const PRAKASH = "+919810000005";

/** Prakash's identity in each society is a separate person row. */
interface Posting {
  societyId: string;
  societyName: string;
  personId: string;
  role: "accountant" | "committee";
}
let postings: Posting[];

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await owner.end();
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetWorld(owner);
  postings = [];

  // Three societies is enough to prove the shape; the persona has nine.
  const societies = [
    { name: "Harmony CGHS, Dwarka", role: "accountant" as const },
    { name: "Riverside CGHS, Rohini", role: "accountant" as const },
    { name: "Patparganj Heights CGHS", role: "committee" as const },
  ];

  for (const s of societies) {
    const societyId = randomUUID();
    await seedSociety(owner, { id: societyId, name: s.name });

    // Two committee members before Prakash arrives. Not padding: the
    // two-member guard refuses to drop a committee to one, so a society seeded
    // with a single member cannot have anyone removed — the third society below
    // makes Prakash a committee member, and the removal test needs to succeed
    // for the right reason rather than be blocked by an unrealistic fixture.
    const founderId = randomUUID();
    await seedPerson(owner, { id: founderId, societyId, name: "Founder" });
    const founder = { id: founderId, name: "Founder", role: "committee" as const };
    for (const [id, seat] of [[founderId, "president"], [randomUUID(), "secretary"]] as const) {
      if (id !== founderId) await seedPerson(owner, { id, societyId, name: "Co-founder" });
      await inTransaction((tx) =>
        grantRole(tx, {
          societyId, personId: id, role: "committee",
          committeeSeat: seat, actor: founder, installId: randomUUID(),
        }),
      );
    }

    // Prakash, same phone number, separate person row per society.
    const personId = randomUUID();
    await seedPerson(owner, { id: personId, societyId, name: "Prakash Joshi", phone: PRAKASH });
    await inTransaction((tx) =>
      grantRole(tx, {
        societyId, personId, role: s.role,
        actor: founder, installId: randomUUID(),
      }),
    );

    postings.push({ societyId, societyName: s.name, personId, role: s.role });
  }
});

/** Sign in the way the app does, and hand back the raw response. */
async function signIn(phone: string) {
  const issued = await inTransaction((tx) => issueChallenge(tx, { phone, channel: "manual" }));
  const res = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { phone, code: issued.code },
  });
  return { status: res.statusCode, body: res.json() };
}

describe("the same number in several societies", () => {
  it("offers the picker instead of guessing which society is meant", async () => {
    const { status, body } = await signIn(PRAKASH);

    expect(status).toBe(200);
    expect(body.status).toBe("choose_society");
    expect(body.societies).toHaveLength(3);

    // Sorted by name, so the list does not reshuffle between logins.
    expect(body.societies.map((s: { name: string }) => s.name)).toEqual([
      "Harmony CGHS, Dwarka",
      "Patparganj Heights CGHS",
      "Riverside CGHS, Rohini",
    ]);
  });

  it("shows the role he holds in each, which is not the same role everywhere", async () => {
    const { body } = await signIn(PRAKASH);
    const byName = new Map(
      body.societies.map((s: { name: string; role: string }) => [s.name, s.role]),
    );

    expect(byName.get("Harmony CGHS, Dwarka")).toBe("accountant");
    expect(byName.get("Riverside CGHS, Rohini")).toBe("accountant");
    expect(byName.get("Patparganj Heights CGHS")).toBe("committee");
  });

  it("issues a separate session per society, each scoped to that society", async () => {
    const { body } = await signIn(PRAKASH);

    for (const society of body.societies) {
      expect(society.accessToken, `${society.name} needs its own token`).toBeTruthy();
      expect(society.refreshToken).toBeTruthy();

      // The token's scope IS the society — there is no "switch society" call
      // that mutates a session, because a session never spans two societies.
      const claims = verifyAccessToken(society.accessToken);
      expect(claims.soc).toBe(society.id);
      expect(claims.role).toBe(society.role);
    }

    const societyIds = body.societies.map((s: { id: string }) => s.id);
    expect(new Set(societyIds).size).toBe(3);
  });

  it("switching is picking the other token, and it reads the other society", async () => {
    const { body } = await signIn(PRAKASH);
    const harmony = body.societies.find((s: { name: string }) => s.name.startsWith("Harmony"));
    const riverside = body.societies.find((s: { name: string }) => s.name.startsWith("Riverside"));

    for (const society of [harmony, riverside]) {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${society.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().society.name).toBe(society.name);
    }
  });

  it("refuses to read one society with another society's token", async () => {
    const { body } = await signIn(PRAKASH);
    const harmony = body.societies.find((s: { name: string }) => s.name.startsWith("Harmony"));
    const riverside = body.societies.find((s: { name: string }) => s.name.startsWith("Riverside"));

    const res = await app.inject({
      method: "GET",
      url: `/societies/${riverside.id}/chain`,
      headers: { authorization: `Bearer ${harmony.accessToken}` },
    });
    // 404, not 403: confirming a society exists to someone outside it is a leak.
    expect(res.statusCode).toBe(404);
  });

  it("goes straight in when only one society remains", async () => {
    // Remove him from two of the three; the picker should stop appearing.
    for (const posting of postings.slice(1)) {
      await inTransaction((tx) =>
        revokeRole(tx, {
          societyId: posting.societyId,
          personId: posting.personId,
          role: posting.role,
          actor: { id: posting.personId, name: "Founder", role: "committee" },
          installId: randomUUID(),
        }),
      );
    }

    const { body } = await signIn(PRAKASH);
    expect(body.status).toBe("signed_in");
    expect(body.society.name).toBe("Harmony CGHS, Dwarka");
    expect(body.you.role).toBe("accountant");
  });
});

describe("revocation in one society leaves the others alone", () => {
  it("keeps him working in Riverside after Harmony removes him", async () => {
    const before = await signIn(PRAKASH);
    const harmony = before.body.societies.find((s: { name: string }) =>
      s.name.startsWith("Harmony"),
    );
    const riverside = before.body.societies.find((s: { name: string }) =>
      s.name.startsWith("Riverside"),
    );

    const harmonyPosting = postings.find((p) => p.societyName.startsWith("Harmony"))!;
    await inTransaction((tx) =>
      revokeRole(tx, {
        societyId: harmonyPosting.societyId,
        personId: harmonyPosting.personId,
        role: "accountant",
        actor: { id: harmonyPosting.personId, name: "Founder", role: "committee" },
        installId: randomUUID(),
      }),
    );

    // Harmony's session is dead.
    const dead = await app.inject({
      method: "GET", url: "/auth/me",
      headers: { authorization: `Bearer ${harmony.accessToken}` },
    });
    expect(dead.statusCode).toBe(401);

    // Riverside's is untouched — the membership version is per society, and so
    // is the consequence of a committee's decision.
    const alive = await app.inject({
      method: "GET", url: "/auth/me",
      headers: { authorization: `Bearer ${riverside.accessToken}` },
    });
    expect(alive.statusCode).toBe(200);
    expect(alive.json().society.name).toBe("Riverside CGHS, Rohini");
  });
});

describe("the membership lookup itself", () => {
  it("finds every active posting for a number, and no revoked one", async () => {
    const all = await membershipsForPhone(PRAKASH);
    expect(all).toHaveLength(3);

    const posting = postings[0]!;
    await inTransaction((tx) =>
      revokeRole(tx, {
        societyId: posting.societyId, personId: posting.personId, role: posting.role,
        actor: { id: posting.personId, name: "Founder", role: "committee" },
        installId: randomUUID(),
      }),
    );

    const remaining = await membershipsForPhone(PRAKASH);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((m) => m.societyName)).not.toContain(posting.societyName);
  });

  it("does not confuse two different people who share nothing but a society", async () => {
    const other = "+919820000099";
    const posting = postings[0]!;
    const personId = randomUUID();
    await seedPerson(owner, {
      id: personId, societyId: posting.societyId, name: "Someone Else", phone: other,
    });
    await inTransaction((tx) =>
      grantRole(tx, {
        societyId: posting.societyId, personId, role: "staff",
        actor: { id: posting.personId, name: "Founder", role: "committee" },
        installId: randomUUID(),
      }),
    );

    const theirs = await membershipsForPhone(other);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.displayName).toBe("Someone Else");

    // Prakash is unaffected. Cheap to assert, and it is the shape of bug that
    // would otherwise surface as one treasurer seeing another's society.
    await pool.query("SELECT 1");
    expect(await membershipsForPhone(PRAKASH)).toHaveLength(3);
  });
});
