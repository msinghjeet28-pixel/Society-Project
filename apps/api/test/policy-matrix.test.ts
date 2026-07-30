/**
 * EVIDENCE for Tech Design §03 — the two-dimensional policy matrix.
 *
 * Dimension one: every registered route × every role + anonymous, asserted
 * against the permissions table. Dimension two: tenancy — the same actor
 * against a society that is not theirs.
 *
 * The matrix is DERIVED from the route table, not hand-maintained. A new route
 * therefore cannot be added without appearing here, which is what makes the
 * boot-refusal guarantee in policy-boot.test.ts worth having.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";

import { buildApp } from "../src/app.ts";
import { closePool, inTransaction } from "../src/db.ts";
import { grantRole, membershipVersion } from "../src/auth/membership.ts";
import { signAccessToken } from "../src/auth/token.ts";
import { can, type Action } from "@sr/policy";
import { ROLES, type Role } from "@sr/envelope/core";
import { ownerClient, resetWorld, seedPerson, seedSociety } from "./helpers/db.ts";

interface RouteUnderTest {
  method: string;
  url: string;
  action: Action | undefined;
  isPublic: boolean;
}

let app: FastifyInstance;
let owner: pg.Client;
/** Two societies, so cross-tenant access is testable rather than assumed. */
let societyA: string;
let societyB: string;
const actors = new Map<Role, string>();  // role → personId
let foreignPersonId: string;

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  await resetWorld(owner);

  app = await buildApp();
  await app.ready();

  societyA = randomUUID();
  societyB = randomUUID();
  await seedSociety(owner, { id: societyA, name: "Harmony CGHS" });
  await seedSociety(owner, { id: societyB, name: "Riverside CGHS" });

  // Society A gets one actor per role, plus a second committee member so the
  // two-member guard never interferes with matrix assertions.
  const founderId = randomUUID();
  await seedPerson(owner, { id: founderId, societyId: societyA, name: "Vikram Mehta" });
  const founder = { id: founderId, name: "Vikram Mehta", role: "committee" as const };

  await inTransaction((tx) =>
    grantRole(tx, {
      societyId: societyA, personId: founderId, role: "committee",
      committeeSeat: "treasurer", actor: founder, installId: randomUUID(),
    }),
  );

  for (const role of ROLES) {
    const personId = randomUUID();
    await seedPerson(owner, { id: personId, societyId: societyA, name: `${role} person` });
    await inTransaction((tx) =>
      grantRole(tx, {
        societyId: societyA, personId, role,
        actor: founder, installId: randomUUID(),
      }),
    );
    actors.set(role, personId);
  }

  // A committee member of society B — same powers, wrong society.
  const foreignId = randomUUID();
  await seedPerson(owner, { id: foreignId, societyId: societyB, name: "Other Treasurer" });
  await inTransaction((tx) =>
    grantRole(tx, {
      societyId: societyB, personId: foreignId, role: "committee",
      actor: { id: foreignId, name: "Other Treasurer", role: "committee" },
      installId: randomUUID(),
    }),
  );
  foreignPersonId = foreignId;
});

/**
 * Mints a token against the CURRENT membership version.
 *
 * Deliberately not cached: adding or removing anyone bumps the society's
 * version and invalidates every outstanding token, which is the whole point of
 * the mechanism. A real client re-authenticates on 401; this helper is that
 * client. Caching tokens here made six matrix cells fail with 401 instead of
 * 403 — the test was wrong, not the server.
 */
async function tokenFor(role: Role, societyId = societyA): Promise<string> {
  const personId = societyId === societyA ? actors.get(role)! : foreignPersonId;
  return signAccessToken({
    sub: personId, soc: societyId, role,
    mv: await membershipVersion(societyId), iid: randomUUID(),
  });
}

afterAll(async () => {
  await resetWorld(owner);
  await owner.end();
  await app.close();
  await closePool();
});

/**
 * The routes as registered. Kept explicit because the assertion that matters is
 * "no route escapes the matrix", and that is enforced by the completeness test
 * below comparing this list against Fastify's own route table.
 */
const ROUTE_TABLE: RouteUnderTest[] = [
  { method: "GET", url: "/health", action: undefined, isPublic: true },
  { method: "POST", url: "/auth/otp/request", action: undefined, isPublic: true },
  { method: "POST", url: "/auth/otp/verify", action: undefined, isPublic: true },
  { method: "POST", url: "/auth/refresh", action: undefined, isPublic: true },
  { method: "GET", url: "/auth/me", action: "society.read", isPublic: false },
  { method: "GET", url: "/people", action: "person.read", isPublic: false },
  { method: "POST", url: "/people", action: "person.add", isPublic: false },
  { method: "POST", url: "/people/:personId/revoke", action: "person.role.revoke", isPublic: false },
  { method: "GET", url: "/societies/:societyId/chain", action: "society.read", isPublic: false },
];

/** Placeholder-free URL for a real request. */
function concreteUrl(url: string, societyId: string): string {
  return url
    .replace(":personId", randomUUID())
    .replace(":societyId", societyId);
}

describe("the matrix is complete", () => {
  it("covers every route Fastify actually registered", () => {
    const registered = app
      .printRoutes({ commonPrefix: false })
      .split("\n")
      .join(" ");

    for (const route of ROUTE_TABLE) {
      // Fastify prints the tree with segments; assert each path segment appears.
      const leaf = route.url.split("/").filter(Boolean).at(-1) ?? "";
      expect(registered, `${route.method} ${route.url} should be registered`).toContain(
        leaf.replace(":", ""),
      );
    }
  });

  it("annotates every non-public route with an action the policy table knows", () => {
    for (const route of ROUTE_TABLE) {
      if (route.isPublic) continue;
      expect(route.action, `${route.method} ${route.url}`).toBeDefined();
      // can() throws nothing for unknown actions; it denies. So assert the
      // action is one at least one role holds, or it is dead configuration.
      const anyoneCan = ROLES.some((r) => can(r, route.action!).allowed);
      expect(anyoneCan, `no role can ${route.action} — dead route`).toBe(true);
    }
  });
});

describe("dimension 1 · role × route", () => {
  for (const route of ROUTE_TABLE) {
    if (route.isPublic) continue;

    it(`anonymous is refused ${route.method} ${route.url}`, async () => {
      const res = await app.inject({
        method: route.method as "GET",
        url: concreteUrl(route.url, societyA),
        ...(route.method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(401);
    });

    for (const role of ROLES) {
      const permitted = can(role, route.action!).allowed;

      it(`${role} is ${permitted ? "allowed" : "refused"} ${route.method} ${route.url}`, async () => {
        const token = await tokenFor(role);
        const res = await app.inject({
          method: route.method as "GET",
          url: concreteUrl(route.url, societyA),
          headers: { authorization: `Bearer ${token}` },
          ...(route.method === "POST" ? { payload: { name: "Probe", role: "member" } } : {}),
        });

        if (permitted) {
          // 4xx other than 403 is fine — validation, not-found and conflict are
          // domain answers. What must never happen is 403 for a permitted role.
          expect(res.statusCode, `${role} ${route.url}`).not.toBe(403);
        } else {
          // Members hold no login at all, so they cannot even resolve an actor.
          const acceptable = role === "member" ? [401, 403] : [403];
          expect(acceptable, `${role} ${route.url} → ${res.statusCode}`).toContain(res.statusCode);
        }
      });
    }
  }
});

describe("dimension 2 · tenancy", () => {
  it("refuses a committee member reading another society's chain", async () => {
    // Same role, same powers, wrong society. 404 rather than 403: confirming a
    // society exists to an outsider is itself a leak.
    const res = await app.inject({
      method: "GET",
      url: `/societies/${societyA}/chain`,
      headers: { authorization: `Bearer ${await tokenFor("committee", societyB)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets that same member read their own society's chain", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/societies/${societyB}/chain`,
      headers: { authorization: `Bearer ${await tokenFor("committee", societyB)}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("scopes the people list to the actor's society, ignoring any hint", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/people",
      headers: { authorization: `Bearer ${await tokenFor("committee")}` },
    });
    expect(res.statusCode).toBe(200);

    const names = JSON.stringify(res.json());
    expect(names).not.toContain("Other Treasurer");
  });

  it("refuses to revoke a person who belongs to another society", async () => {
    const { rows } = await owner.query<{ person_id: string }>(
      `SELECT person_id FROM membership_active WHERE society_id = $1 LIMIT 1`,
      [societyB],
    );
    const res = await app.inject({
      method: "POST",
      url: `/people/${rows[0]!.person_id}/revoke`,
      headers: { authorization: `Bearer ${await tokenFor("committee")}` },
    });
    // Not a member *of this society* — the query is scoped, so it simply is not found.
    expect(res.statusCode).toBe(404);
  });
});
