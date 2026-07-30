import { buildApp } from "./app.ts";
import { closePool, pool } from "./db.ts";
import { runMigrations } from "./db/migrate.ts";

/**
 * Render's free tier has no pre-deploy command, so migrations run at startup
 * when asked. Safe under concurrent boots: runMigrations takes an advisory lock.
 * On a paid plan, prefer the pre-deploy step and leave this off.
 */
if (process.env["RUN_MIGRATIONS_ON_BOOT"] === "true") {
  const client = await pool.connect();
  try {
    const result = await runMigrations(client, (m) => console.log(`  migrate: ${m}`));
    console.log(
      result.applied.length > 0
        ? `migrate: applied ${result.applied.length} migration(s)`
        : `migrate: schema up to date (${result.alreadyApplied} applied previously)`,
    );
  } catch (err) {
    console.error("migrate: FAILED —", err instanceof Error ? err.message : err);
    // Serving requests against a schema we could not migrate risks writing
    // half-shaped entries into an append-only ledger, which cannot be undone.
    process.exit(1);
  } finally {
    client.release();
  }
}

const app = await buildApp();

// Render provides PORT and requires binding 0.0.0.0.
const port = Number(process.env["PORT"] ?? 3000);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      await closePool();
      process.exit(0);
    })();
  });
}
