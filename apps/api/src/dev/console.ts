import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * A developer console for exercising the API by hand.
 *
 * This is NOT the product. The product is an Android app (Arch §03) and the
 * public page renderer; this is scaffolding so the team and the PM can drive
 * real flows against real data before those exist.
 *
 * Two hard guards, because a console that reads OTP codes is an authentication
 * bypass wearing a lab coat:
 *
 *   1. Registration throws if NODE_ENV is production.
 *   2. It only registers at all when DEV_CONSOLE=on is set explicitly.
 *
 * Codes are stored hashed and cannot be read back from the database — by
 * design. The console therefore relies on a sender that keeps the last code per
 * phone in memory, in this process, for this session only.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Last code per phone, in memory, dev only. Never persisted. */
const lastCodes = new Map<string, { code: string; at: number }>();

export function recordCode(phone: string, code: string): void {
  if (process.env["NODE_ENV"] === "production") return;
  lastCodes.set(phone, { code, at: Date.now() });
}

export function isDevConsoleEnabled(): boolean {
  return process.env["DEV_CONSOLE"] === "on" && process.env["NODE_ENV"] !== "production";
}

const devConsoleImpl: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "the dev console must never be registered in production — it reveals one-time codes",
    );
  }

  app.log.warn("dev console enabled at /dev — one-time codes are readable; never do this in production");

  app.get("/dev", { config: { policyPublic: true } }, async (_request, reply) => {
    const html = await readFile(join(here, "console.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /**
   * The code that was just "sent". Exists so a human can complete the login
   * flow without reading server logs.
   */
  app.get("/dev/last-code", { config: { policyPublic: true } }, async (request, reply) => {
    const phone = (request.query as { phone?: string }).phone;
    if (!phone) return reply.code(400).send({ error: "phone is required" });

    const entry = lastCodes.get(phone);
    if (!entry) return reply.code(404).send({ error: "no code has been sent to that number" });

    return { code: entry.code, ageMs: Date.now() - entry.at };
  });

  /** A one-tap way to get back to a known state while poking around. */
  app.post("/dev/reset", { config: { policyPublic: true } }, async () => {
    const { pool } = await import("../db.ts");
    await pool.query(
      "TRUNCATE membership_event, otp_challenge, refresh_token, counter, membership_version, person, invite_code, society CASCADE",
    );
    lastCodes.clear();
    return { reset: true };
  });
};

export const devConsolePlugin = fp(devConsoleImpl, { name: "sr-dev-console", fastify: "5.x" });
