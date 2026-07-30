import Fastify, { type FastifyInstance } from "fastify";
import { policyPlugin } from "./plugins/policy.ts";
import { pool } from "./db.ts";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      // Never log a phone number or an OTP.
      redact: ["req.body.phone", "req.body.code", "req.headers.authorization"],
    },
    // Render terminates TLS and forwards the client IP here.
    trustProxy: true,
  });

  await app.register(policyPlugin);

  app.get(
    "/health",
    { config: { policyPublic: true } },
    async () => {
      const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
      return { status: "ok", db: rows[0]?.ok === 1 };
    },
  );

  /**
   * Chain verification status per society — the read side of the nightly job
   * (Arch §15). Committee-visible so a society can check its own record.
   */
  app.get(
    "/societies/:id/chain",
    { config: { policyAction: "society.read" } },
    async (request) => {
      const { rows } = await pool.query<{ chain_head: string; entries: string }>(
        `SELECT s.chain_head,
                (SELECT count(*) FROM membership_event me WHERE me.society_id = s.id)::text AS entries
           FROM society s WHERE s.id = $1`,
        [request.actor!.societyId],
      );
      const row = rows[0];
      if (!row) return { found: false };
      return { chainHead: row.chain_head, entries: Number(row.entries) };
    },
  );

  return app;
}
