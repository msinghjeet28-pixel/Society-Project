import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "../db.ts";

/**
 * Migration runner, shared by the CLI (tools/migrate.ts) and by API startup.
 *
 * Startup migration is a deliberate choice for Render's free tier, which has no
 * pre-deploy command. It is safe because of the advisory lock below: several
 * instances booting at once will serialise, and only the first applies anything.
 * If we later move to a paid plan, running this as a pre-deploy step is
 * strictly better — the app should not need write-DDL rights at runtime — and
 * the same function serves both.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

/** Arbitrary but fixed: any process running migrations takes this one lock. */
const MIGRATION_LOCK_KEY = 947_213_004;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(
  client: Queryable,
  log: (message: string) => void = () => {},
): Promise<MigrationResult> {
  // Session-level lock, released explicitly below. Not a transaction lock: each
  // migration runs in its own transaction, so the lock must outlive them.
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migration",
    );
    const already = new Set(rows.map((r) => r.filename));

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];

    for (const file of files) {
      if (already.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      log(`applying ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied: already.size };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
}
