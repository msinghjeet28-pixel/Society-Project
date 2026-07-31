import pg from "pg";

/**
 * Test fixture support.
 *
 * Note what is NOT here: a way to delete a ledger entry. The immutability
 * trigger refuses DELETE even for the owner, which means test teardown cannot
 * tidy up row by row — the first run of the immutability suite proved this by
 * failing its own afterAll.
 *
 * The honest resolution is the one production already implies: nothing is ever
 * deleted, so tests do not delete. They reset the whole world with TRUNCATE,
 * which row-level triggers do not intercept and only the owner may run.
 * A disposable database is a test concern; the ledger's promise is unaffected.
 */

export const TEST_DATABASE_URL = (() => {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set — integration tests need a real Postgres");

  // These tests TRUNCATE every table on the way in. Pointed at a development
  // database that is exactly what they do, and the seeded society disappears
  // mid-session with no error to explain it — which is how this guard came to
  // exist. The name must say out loud that the data is disposable.
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(
      `refusing to run against database "${name}" — the suite truncates every table.\n` +
        `Point DATABASE_URL at a database whose name ends in _test:\n\n` +
        `  createdb societyrecord_test\n` +
        `  DATABASE_URL="postgresql://$(whoami)@localhost:5432/societyrecord_test" pnpm test\n`,
    );
  }
  return url;
})();

const isLocal =
  TEST_DATABASE_URL.includes("localhost") || TEST_DATABASE_URL.includes("127.0.0.1");

export function ownerClient(): pg.Client {
  return new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

/**
 * A bounded pool for tests that fan out.
 *
 * Deliberately small. An earlier version of the counter test opened a fresh
 * connection per concurrent issuance — 100 of them — and CI answered "sorry, too
 * many clients already" while local squeaked under the limit by luck. Bounding
 * the pool is both more robust and more faithful: production runs with
 * PG_POOL_MAX of 5 on Render's free tier, so contention on the counter row is
 * what the test should reproduce, not socket exhaustion.
 *
 * Lazily created and recreated after close: every test file runs in one process
 * (see vitest.config.ts), so a pool ended by the first file's teardown would
 * leave every later file without connections.
 */
let appPool: pg.Pool | null = null;

function pool(): pg.Pool {
  appPool ??= new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 12,
    application_name: "sr-test-app-role",
  });
  return appPool;
}

/** A connection with the API's real privileges, so tests attack what ships. */
export async function withAppRole<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("SET ROLE app_rw");
    return await fn(c);
  } finally {
    // SET ROLE outlives the transaction and rides the connection back into the
    // pool. Without this, an unrelated later test silently runs as app_rw and
    // fails somewhere far from the cause.
    try {
      await c.query("RESET ROLE");
    } finally {
      c.release();
    }
  }
}

export async function closeTestPool(): Promise<void> {
  const existing = appPool;
  appPool = null;
  await existing?.end();
}

const LEDGER_TABLES = ["membership_event"] as const;
const SUPPORT_TABLES = [
  "counter",
  "membership_version",
  "person",
  "invite_code",
  "society",
] as const;

/**
 * Session machinery. Easy to forget, because nothing about a society's record
 * lives here — but OTP rate limits are counted from otp_challenge, so leaving
 * it behind means the fourth sign-in in a file fails with "too many codes
 * requested for this number" and the test looks like a product bug.
 */
const SESSION_TABLES = ["otp_challenge", "refresh_token"] as const;

/** Wipe everything except applied-migration bookkeeping. Owner only. */
export async function resetWorld(client: pg.Client): Promise<void> {
  await client.query(
    `TRUNCATE ${[...LEDGER_TABLES, ...SUPPORT_TABLES, ...SESSION_TABLES].join(", ")} CASCADE`,
  );
}

export interface SeededSociety {
  societyId: string;
  name: string;
}

export async function seedSociety(
  client: pg.Client,
  opts: { id: string; name?: string; flats?: number; language?: "en" | "hi" },
): Promise<SeededSociety> {
  const name = opts.name ?? "Harmony CGHS";
  await client.query(
    `INSERT INTO society (id, name, flat_count, message_language) VALUES ($1,$2,$3,$4)`,
    [opts.id, name, opts.flats ?? 92, opts.language ?? "en"],
  );
  await client.query(`INSERT INTO membership_version (society_id) VALUES ($1)`, [opts.id]);
  await client.query(
    `INSERT INTO counter (society_id, kind) VALUES ($1,'receipt'), ($1,'complaint')`,
    [opts.id],
  );
  return { societyId: opts.id, name };
}

export async function seedPerson(
  client: pg.Client,
  opts: { id: string; societyId: string; name: string; phone?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO person (id, society_id, display_name, phone_e164) VALUES ($1,$2,$3,$4)`,
    [opts.id, opts.societyId, opts.name, opts.phone ?? null],
  );
}
