import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Role } from "@sr/envelope/core";
import { verifyAccessToken, TokenError } from "../auth/token.ts";
import { activeMembership, membershipVersion } from "../auth/membership.ts";

/**
 * Resolves who is making the request (Arch §07).
 *
 * Runs before the policy plugin: authentication establishes identity, then
 * policy decides what that identity may do.
 *
 * The membership-version check is the mechanism behind "revocation takes
 * effect on every device". A token carries the version it was minted with; any
 * role change in the society bumps the version; the next request from a stale
 * token fails and the client silently re-authenticates. No polling, no push
 * dependency, no waiting for a token to expire.
 *
 * Must be wrapped in fastify-plugin — a plain plugin's hooks are encapsulated
 * and would resolve no actor for parent-instance routes.
 */

const actorPluginImpl: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return; // anonymous; policy decides

    const token = header.slice("Bearer ".length).trim();

    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch (err) {
      if (err instanceof TokenError) {
        return reply.code(401).send({ error: "session expired", reason: err.message });
      }
      throw err;
    }

    // Freshly, server-side, on every request.
    const currentVersion = await membershipVersion(claims.soc);
    if (currentVersion !== claims.mv) {
      // Something about this society's roles changed. Do not trust the token's
      // claim about the role; make the client come back for a new one.
      return reply.code(401).send({ error: "session expired", reason: "roles changed" });
    }

    // Belt and braces: the version matching proves nothing changed, but a
    // person removed and re-added within one version bump must not slip
    // through, and this is one indexed lookup.
    const membership = await activeMembership(claims.sub, claims.soc);
    if (!membership) {
      return reply.code(401).send({ error: "session expired", reason: "no longer a member" });
    }

    request.actor = {
      personId: claims.sub,
      societyId: claims.soc,
      role: membership.role as Role,
      displayName: membership.displayName,
      installId: claims.iid,
      membershipVersion: currentVersion,
    };
  });
};

export const actorPlugin = fp(actorPluginImpl, { name: "sr-actor", fastify: "5.x" });
