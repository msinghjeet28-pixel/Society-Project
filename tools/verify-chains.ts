/**
 * GUARDRAIL — nightly chain verification (Arch §15, Tech Design §02).
 *
 * Walks every society's hash chain and exits non-zero on the first broken
 * link. Render runs this as a cron job; a failed job is the alarm.
 *
 * This is what makes layer 4 real. Without a job that actually checks, the
 * chain is a column nobody reads.
 */
import pg from "pg";
import { verifyChain, type ChainLink } from "../packages/envelope/src/core/hashchain.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const isLocal = DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1");
const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

await client.connect();

const { rows: societies } = await client.query<{ id: string; name: string; chain_head: string }>(
  "SELECT id, name, chain_head FROM society ORDER BY created_at",
);

let broken = 0;

for (const society of societies) {
  const links = await loadChain(society.id);
  const verdict = verifyChain(links);

  if (!verdict.ok) {
    broken++;
    console.error(
      `BROKEN CHAIN · society ${society.name} (${society.id})\n` +
        `  entry:    ${verdict.brokenAt}\n` +
        `  position: ${verdict.position} of ${links.length}\n` +
        `  reason:   ${verdict.reason}`,
    );
    continue;
  }

  // The stored head must match the last computed hash, or something wrote a
  // row without advancing the chain.
  const expectedHead = links.at(-1)?.entryHash ?? "0".repeat(64);
  if (expectedHead !== society.chain_head) {
    broken++;
    console.error(
      `HEAD MISMATCH · society ${society.name} (${society.id})\n` +
        `  stored head:   ${society.chain_head}\n` +
        `  computed head: ${expectedHead}`,
    );
    continue;
  }

  console.log(`ok · ${society.name} · ${verdict.length} entries`);
}

await client.end();

if (broken > 0) {
  console.error(`\n${broken} of ${societies.length} societies failed verification`);
  process.exit(1);
}

console.log(`\nall ${societies.length} societ${societies.length === 1 ? "y" : "ies"} verified`);

/**
 * Loads every ledger entry for a society in chain order.
 *
 * As ledger tables are added (expense, payment, complaint_event), each needs a
 * branch here. The shared envelope is what keeps that a UNION rather than a
 * bespoke reader per entity.
 */
async function loadChain(societyId: string): Promise<ChainLink[]> {
  const { rows } = await client.query<{
    id: string;
    society_id: string;
    kind: string;
    actor_id: string;
    actor_role: string;
    occurred_at: Date;
    recorded_at: Date;
    content: string;
    corrects_id: string | null;
    prev_hash: string;
    entry_hash: string;
  }>(
    `SELECT id, society_id,
            'membership.' || kind      AS kind,
            actor_id, actor_role, occurred_at, recorded_at,
            'role=' || role            AS content,
            NULL::uuid                 AS corrects_id,
            prev_hash, entry_hash
       FROM membership_event
      WHERE society_id = $1
      ORDER BY recorded_at, entry_hash`,
    [societyId],
  );

  return rows.map((r) => ({
    id: r.id,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    entry: {
      id: r.id,
      societyId: r.society_id,
      kind: r.kind,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      occurredAt: r.occurred_at.toISOString(),
      recordedAt: r.recorded_at.toISOString(),
      content: r.content,
      corrects_id: r.corrects_id ?? undefined,
    } as ChainLink["entry"],
  }));
}
