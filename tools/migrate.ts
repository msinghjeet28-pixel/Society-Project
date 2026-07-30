/**
 * Migration runner. Deliberately tiny: applies numbered .sql files in order,
 * inside a transaction each, recording what ran.
 *
 * Runs on Render as a pre-deploy command, and locally against the dev DB.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const reset = process.argv.includes("--reset");

const client = new pg.Client({
  connectionString: DATABASE_URL,
  // Render's managed Postgres requires TLS; local dev does not have it.
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

await client.connect();

if (reset) {
  console.warn("--reset: dropping and recreating schema public");
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`);

const applied = new Set<string>(
  (await client.query<{ filename: string }>("SELECT filename FROM schema_migration")).rows.map(
    (r) => r.filename,
  ),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(join(migrationsDir, file), "utf8");
  process.stdout.write(`applying ${file} … `);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log("ok");
    ran++;
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("FAILED");
    console.error(err instanceof Error ? err.message : err);
    await client.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? "no pending migrations" : `${ran} migration(s) applied`);
await client.end();
