/**
 * Migration CLI. The runner itself lives in apps/api/src/db/migrate.ts so that
 * startup migration and this command can never drift apart.
 *
 *   pnpm db:migrate          apply pending migrations
 *   pnpm db:reset            drop the schema first (local only)
 */
import pg from "pg";
import { runMigrations } from "../apps/api/src/db/migrate.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const isLocal = DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1");
const reset = process.argv.includes("--reset");

if (reset && !isLocal) {
  console.error("--reset refuses to run against a non-local database");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

await client.connect();

if (reset) {
  console.warn("--reset: dropping and recreating schema public");
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

try {
  const result = await runMigrations(client, (m) => console.log(m));
  console.log(
    result.applied.length === 0
      ? "no pending migrations"
      : `${result.applied.length} migration(s) applied`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await client.end();
  process.exit(1);
}

await client.end();
