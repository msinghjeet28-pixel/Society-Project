import pg from "pg";

/**
 * The API connects as app_rw — the role with no UPDATE or DELETE on ledger
 * tables (migration 0001). That is Arch §04 layer 2, and it is why a bug in
 * this codebase cannot rewrite a receipt.
 */

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is not set");

const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

export const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env["PG_POOL_MAX"] ?? 10),
  idleTimeoutMillis: 30_000,
  // bigint columns must not silently become JS numbers.
  application_name: "sr-api",
});

// pg returns bigint as string by default, which is what we want for paise.
// Assert it loudly rather than trusting the default.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export type Tx = pg.PoolClient;

/** Run a function in a transaction, rolling back on any throw. */
export async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
