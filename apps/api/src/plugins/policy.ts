import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { can, type Action } from "@sr/policy";
import type { Role } from "@sr/envelope/core";

/**
 * The policy plugin (Tech Design §03).
 *
 * Two guarantees, both structural rather than remembered:
 *
 *   1. Every route must declare `policyAction` (or opt out explicitly with
 *      `policyPublic: true`). Registration THROWS otherwise, so an
 *      unprotected route cannot exist — not even long enough to be deployed.
 *
 *   2. Authorisation runs in one preHandler, deny by default, server-side.
 *      society_id is resolved from the actor's membership and never trusted
 *      from the request body — the cross-tenant hole the §03 critique found.
 *
 * MUST be wrapped in fastify-plugin. A plain plugin is encapsulated, and its
 * hooks then apply only to routes registered *inside* it — every route on the
 * parent instance would be unauthenticated. The evidence test for this file
 * caught exactly that bug; `fp()` is load-bearing, not ceremony.
 *
 * Register this before any route: onRoute only sees routes added after it.
 */

declare module "fastify" {
  interface FastifyContextConfig {
    /** The permission this route requires. */
    policyAction?: Action;
    /** Explicit opt-out, for health checks and OTP endpoints. */
    policyPublic?: true;
  }
  interface FastifyRequest {
    actor?: Actor;
  }
}

export interface Actor {
  personId: string;
  societyId: string;
  role: Role;
  displayName: string;
  installId: string;
  membershipVersion: number;
}

export class PolicyConfigError extends Error {}

const policyPluginImpl: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("onRoute", (route) => {
    // HEAD is auto-generated alongside GET; OPTIONS is CORS machinery.
    if (route.method === "HEAD" || route.method === "OPTIONS") return;

    const cfg = route.config as { policyAction?: Action; policyPublic?: true } | undefined;
    if (!cfg?.policyAction && !cfg?.policyPublic) {
      // Thrown synchronously from app.get()/app.post(), so the stack points at
      // the offending route rather than at boot.
      throw new PolicyConfigError(
        `route ${String(route.method)} ${route.url} declares no policyAction.\n` +
          `Add { config: { policyAction: "…" } }, or { config: { policyPublic: true } } ` +
          `for an intentionally open route such as health or OTP.`,
      );
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    const cfg = request.routeOptions.config as
      | { policyAction?: Action; policyPublic?: true }
      | undefined;

    if (cfg?.policyPublic) return;

    const action = cfg?.policyAction;
    if (!action) {
      // Unreachable in a booted server; kept so a dynamically added route
      // fails closed rather than open.
      return reply.code(500).send({ error: "route has no policy action" });
    }

    const actor = request.actor;
    if (!actor) {
      return reply.code(401).send({ error: "authentication required" });
    }

    const verdict = can(actor.role, action);
    if (!verdict.allowed) {
      request.log.info({ action, role: actor.role }, "policy denied");
      return reply.code(403).send({ error: "not permitted" });
    }

    // `own` scope is enforced by the domain service, which knows what the
    // entry is — the policy layer answers "may this role do this action",
    // services answer "may this action have these values" (§03 critique).
    request.policyScope = verdict.scope;
  });
};

/**
 * fp() lifts the hooks out of the plugin's encapsulation context so they guard
 * the parent instance's routes too. Without it the plugin silently protects
 * nothing.
 */
export const policyPlugin = fp(policyPluginImpl, {
  name: "sr-policy",
  fastify: "5.x",
});

declare module "fastify" {
  interface FastifyRequest {
    policyScope?: "all" | "own";
  }
}

/** Resolve the society from the actor, never from client input. */
export function societyOf(request: FastifyRequest): string {
  const actor = request.actor;
  if (!actor) throw new Error("societyOf called without an actor");
  return actor.societyId;
}
