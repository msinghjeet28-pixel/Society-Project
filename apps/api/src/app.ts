import Fastify, { type FastifyInstance } from "fastify";
import { actorPlugin } from "./plugins/actor.ts";
import { policyPlugin } from "./plugins/policy.ts";
import { authRoutes } from "./routes/auth.ts";
import { peopleRoutes } from "./routes/people.ts";
import { pool } from "./db.ts";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      // A logged OTP or phone number is a credential in a log aggregator.
      redact: [
        "req.body.phone",
        "req.body.code",
        "req.body.refreshToken",
        "req.headers.authorization",
      ],
    },
    // Render terminates TLS and forwards the client IP, which the OTP rate
    // limiter depends on being accurate.
    trustProxy: true,
  });

  // Order is the design: identity first, then permission. Both are wrapped in
  // fastify-plugin so their hooks guard routes registered on this instance.
  await app.register(actorPlugin);
  await app.register(policyPlugin);

  app.get("/health", { config: { policyPublic: true } }, async () => {
    const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    return { status: "ok", db: rows[0]?.ok === 1 };
  });

  await app.register(authRoutes);
  await app.register(peopleRoutes);

  return app;
}
