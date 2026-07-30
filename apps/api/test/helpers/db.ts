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
  return url;
})();

const isLocal =
  TEST_DATABASE_URL.includes("localhost") || TEST_DATABASE_URL.includes("127.0.0.1");

export function ownerClient(): pg.Client {
  return new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

/** A connection with the API's real privileges, so tests attack what ships. */
export async function withAppRole<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = ownerClient();
  await c.connect();
  try {
    await c.query("SET ROLE app_rw");
    return await fn(c);
  } finally {
    await c.end();
  }
}

const LEDGER_TABLES = ["membership_event"] as const;
const SUPPORT_TABLES = [
  "counter",
  "membership_version",
  "person",
  "invite_code",
  "society",
] as const;

/** Wipe everything except applied-migration bookkeeping. Owner only. */
export async function resetWorld(client: pg.Client): Promise<void> {
  await client.query(
    `TRUNCATE ${[...LEDGER_TABLES, ...SUPPORT_TABLES].join(", ")} CASCADE`,
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
