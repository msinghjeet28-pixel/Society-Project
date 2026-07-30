/**
 * Development seed: the prototype's world, in real rows.
 *
 * Harmony CGHS, Dwarka — 92 flats, the committee and staff from the personas.
 * Useful for local work now, and the basis for the pilot seed tooling in
 * week 8.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashEntry } from "../packages/envelope/src/core/hashchain.ts";
import { rupeesToPaise, formatRupees } from "../packages/envelope/src/core/money.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const isLocal = DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1");
const c = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
await c.connect();

if (!isLocal) {
  console.error("refusing to seed a non-local database");
  process.exit(1);
}

await c.query(
  "TRUNCATE membership_event, counter, membership_version, person, invite_code, society CASCADE",
);

// An invite code, as D-001 requires, consumed by the society it created.
const societyId = randomUUID();
await c.query(
  `INSERT INTO invite_code (code, channel) VALUES ('DWARKA-01', 'ca-referral-dwarka')`,
);

await c.query(
  `INSERT INTO society (id, name, flat_count, message_language, staff_cash_limit_paise)
   VALUES ($1, 'Harmony CGHS, Dwarka', 92, 'en', $2)`,
  [societyId, rupeesToPaise("2000").toString()],
);
await c.query(
  `UPDATE invite_code SET consumed_at = now(), consumed_by = $1 WHERE code = 'DWARKA-01'`,
  [societyId],
);
await c.query(`INSERT INTO membership_version (society_id) VALUES ($1)`, [societyId]);
await c.query(
  `INSERT INTO counter (society_id, kind) VALUES ($1,'receipt'), ($1,'complaint')`,
  [societyId],
);

// The personas from the PRD.
const people = [
  { name: "Vikram Mehta", phone: "+919810000001", role: "committee", seat: "treasurer" },
  { name: "Sudha Menon", phone: "+919810000002", role: "committee", seat: "secretary" },
  { name: "R. K. Bedekar", phone: "+919810000003", role: "committee", seat: "president" },
  { name: "Santosh Yadav", phone: "+919810000004", role: "staff", seat: null },
  { name: "Prakash Joshi", phone: "+919810000005", role: "accountant", seat: null },
] as const;

// Vikram sets the society up, so he is the actor on every grant.
const founderId = randomUUID();
await c.query(
  `INSERT INTO person (id, society_id, display_name, phone_e164) VALUES ($1,$2,$3,$4)`,
  [founderId, societyId, people[0].name, people[0].phone],
);

for (const [index, p] of people.entries()) {
  const personId = index === 0 ? founderId : randomUUID();
  if (index > 0) {
    await c.query(
      `INSERT INTO person (id, society_id, display_name, phone_e164) VALUES ($1,$2,$3,$4)`,
      [personId, societyId, p.name, p.phone],
    );
  }

  const id = randomUUID();
  const occurredAt = new Date(Date.now() - (people.length - index) * 60_000).toISOString();

  await c.query("BEGIN");
  const { rows } = await c.query<{ head: string }>("SELECT lock_chain($1) AS head", [societyId]);
  const prevHash = rows[0]!.head;
  const recordedAt = new Date().toISOString();

  const entryHash = hashEntry(
    {
      id,
      societyId,
      kind: "membership.granted",
      actorId: founderId,
      actorRole: "committee",
      occurredAt,
      recordedAt,
      content: `role=${p.role}`,
    },
    prevHash,
  );

  await c.query(
    `INSERT INTO membership_event
       (id, society_id, person_id, kind, role, committee_seat, actor_id, actor_name,
        actor_role, install_id, occurred_at, recorded_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,'granted',$4,$5,$6,'Vikram Mehta','committee',$7,$8,$9,$10,$11)`,
    [id, societyId, personId, p.role, p.seat, founderId, randomUUID(),
     occurredAt, recordedAt, prevHash, entryHash],
  );
  await c.query("SELECT advance_chain($1,$2)", [societyId, entryHash]);
  await c.query("COMMIT");
}

const { rows: head } = await c.query<{ chain_head: string }>(
  "SELECT chain_head FROM society WHERE id = $1",
  [societyId],
);

console.log(`seeded  Harmony CGHS, Dwarka · 92 flats`);
console.log(`        society id  ${societyId}`);
console.log(`        staff limit ${formatRupees(rupeesToPaise("2000"), { paise: false })}`);
console.log(`        ${people.length} people, ${people.length} ledger entries`);
console.log(`        chain head  ${head[0]!.chain_head.slice(0, 24)}…`);

await c.end();
