/**
 * EVIDENCE for Tech Design §03 — the plugin that enforces the policy table.
 *
 * The table's own properties are asserted in packages/policy. This file covers
 * enforcement: an unannotated route cannot exist, and the hooks actually guard
 * the routes they are supposed to guard.
 *
 * The full matrix (roles × routes × tenancy) arrives with the first real data
 * routes; the boot refusal is what makes that matrix trustworthy, because a
 * route it forgot to cover cannot be registered at all.
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { policyPlugin, PolicyConfigError } from "../src/plugins/policy.ts";

describe("an unannotated route cannot exist", () => {
  it("refuses registration of a route with no policy action", async () => {
    const app = Fastify();
    await app.register(policyPlugin);

    expect(() => app.get("/leaky", async () => ({ secrets: "everything" }))).toThrow(
      PolicyConfigError,
    );
    await app.close();
  });

  it("names the offending route and both fixes", async () => {
    const app = Fastify();
    await app.register(policyPlugin);

    expect(() => app.post("/expenses", async () => ({}))).toThrow(
      /POST \/expenses declares no policyAction[\s\S]*policyPublic/,
    );
    await app.close();
  });

  it("accepts annotated and explicitly-public routes", async () => {
    const app = Fastify();
    await app.register(policyPlugin);
    app.get("/health", { config: { policyPublic: true } }, async () => ({ ok: true }));
    app.get("/expenses", { config: { policyAction: "expense.read" } }, async () => []);

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it("guards routes on the PARENT instance, not just inside the plugin", async () => {
    // Regression test for a real defect: registered as a plain (encapsulated)
    // plugin, the hooks applied to nothing and every route was open. fp() is
    // what makes this pass.
    const app = Fastify();
    await app.register(policyPlugin);
    let handlerRan = false;
    app.get("/guarded", { config: { policyAction: "expense.approve" } }, async () => {
      handlerRan = true;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(401);
    expect(handlerRan).toBe(false);

    await app.close();
  });
});

describe("enforcement", () => {
  it("returns 401 without an actor, 403 for a forbidden action, 200 when permitted", async () => {
    const app = Fastify();
    // The actor resolver runs before the policy plugin, as it will in
    // production: authentication establishes who you are, then policy decides
    // what you may do.
    app.addHook("preHandler", async (req) => {
      const role = req.headers["x-test-role"];
      if (typeof role === "string") {
        req.actor = {
          personId: "p", societyId: "s", role: role as never,
          displayName: "Santosh", installId: "i", membershipVersion: 1,
        };
      }
    });
    await app.register(policyPlugin);
    app.get("/approve", { config: { policyAction: "expense.approve" } }, async () => ({ ok: true }));
    await app.ready();

    const anon = await app.inject({ method: "GET", url: "/approve" });
    expect(anon.statusCode).toBe(401);

    const staff = await app.inject({
      method: "GET", url: "/approve", headers: { "x-test-role": "staff" },
    });
    expect(staff.statusCode).toBe(403);

    const committee = await app.inject({
      method: "GET", url: "/approve", headers: { "x-test-role": "committee" },
    });
    expect(committee.statusCode).toBe(200);

    await app.close();
  });

  it("exposes the grant scope so services can enforce own-entry rules", async () => {
    const app = Fastify();
    let seenScope: string | undefined;
    app.addHook("preHandler", async (req) => {
      req.actor = {
        personId: "p", societyId: "s", role: "staff",
        displayName: "Santosh", installId: "i", membershipVersion: 1,
      };
    });
    await app.register(policyPlugin);
    app.get("/correct", { config: { policyAction: "entry.correct" } }, async (req) => {
      seenScope = req.policyScope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/correct" });
    expect(res.statusCode).toBe(200);
    // Staff may correct only their own entries; the service needs to know.
    expect(seenScope).toBe("own");

    await app.close();
  });
});
