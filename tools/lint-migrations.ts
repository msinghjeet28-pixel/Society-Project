/**
 * GUARDRAIL — the migration linter (Tech Design §02).
 *
 * The immutability layers protect the running system. This protects them from
 * us: a migration is the one place with enough privilege to quietly make a
 * ledger table mutable, drop a trigger, or rewrite history to fix a support
 * ticket. Those diffs must be impossible to merge by accident.
 *
 * Escape hatch for genuine schema evolution: an explicit
 *   -- migration-lint: allow <rule> — <reason>
 * comment in the file. It is loud in review, and CODEOWNERS puts a second
 * reviewer on migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/** Tables whose rows are ledger entries. Keep in step with make_ledger_table(). */
const LEDGER_TABLES = ["membership_event", "expense", "payment", "complaint_event", "approval"];

interface Rule {
  name: string;
  /** A regex to match, or a predicate over the comment-stripped SQL. */
  test: RegExp | ((sql: string) => boolean);
  message: string;
}

function violates(rule: Rule, sql: string): boolean {
  return typeof rule.test === "function" ? rule.test(sql) : rule.test.test(sql);
}

const RULES: Rule[] = [
  {
    name: "no-ledger-update",
    test: new RegExp(`\\bUPDATE\\s+(?:public\\.)?(${LEDGER_TABLES.join("|")})\\b`, "i"),
    message: "UPDATE against a ledger table. Corrections are new entries, never edits.",
  },
  {
    name: "no-ledger-delete",
    test: new RegExp(`\\bDELETE\\s+FROM\\s+(?:public\\.)?(${LEDGER_TABLES.join("|")})\\b`, "i"),
    message: "DELETE against a ledger table. Nothing is ever deleted (Story 1.4).",
  },
  {
    name: "no-ledger-truncate",
    test: new RegExp(`\\bTRUNCATE\\b[^;]*\\b(${LEDGER_TABLES.join("|")})\\b`, "i"),
    message: "TRUNCATE against a ledger table wipes history without a trace.",
  },
  {
    name: "no-drop-immutability-trigger",
    test: /\bDROP\s+TRIGGER\b[^;]*_immutable\b/i,
    message: "Dropping an immutability trigger removes Arch §04 layer 3.",
  },
  {
    name: "no-grant-ledger-write",
    test: new RegExp(
      `\\bGRANT\\b[^;]*\\b(UPDATE|DELETE|TRUNCATE)\\b[^;]*\\bON\\b[^;]*\\b(${LEDGER_TABLES.join("|")})\\b`,
      "i",
    ),
    message: "Granting UPDATE/DELETE on a ledger table undoes Arch §04 layer 2.",
  },
  {
    // Found the hard way. `CHECK (corrects_id IS NULL OR length(trim(reason)) > 0)`
    // passes when reason is NULL, because the expression evaluates to NULL and a
    // CHECK rejects only FALSE — so the constraint is toothless in exactly the
    // case it exists for. Every ledger table added from here (expense, payment,
    // complaint_event) will copy this constraint, so the rule catches the copy.
    name: "correction-reason-check-must-handle-null",
    // Fires on a DECLARATION of the column, not a mention of it: matching the
    // bare word flagged 0001, which names corrects_id inside the immutability
    // trigger's hint string. Matching only the offending CHECK went the other
    // way and flagged the neighbouring `corrects_id <> id` constraint. Declaring
    // the column is the moment the guard has to exist.
    test: (sql: string) =>
      /\bcorrects_id\s+uuid\b/i.test(sql) &&
      !/correct_reason\s+IS\s+NOT\s+NULL/i.test(sql),
    message:
      "a correction-reason CHECK must test `correct_reason IS NOT NULL` explicitly. Without it a " +
      "NULL reason makes the expression NULL, and a CHECK only rejects FALSE — the constraint " +
      "passes precisely when the reason is missing.",
  },
  {
    name: "no-public-ro-base-tables",
    test: /\bGRANT\b[^;]*\bON\b(?![^;]*public_)[^;]*\bTO\s+public_ro\b/i,
    message:
      "public_ro may only be granted SELECT on public_* views. Base-table access is how a " +
      "balance or a phone number reaches an unauthenticated page (Arch §08).",
  },
];

/** Strip comments so a rule name inside a comment is not itself a violation. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function allowances(sql: string): Set<string> {
  const allowed = new Set<string>();
  for (const match of sql.matchAll(/--\s*migration-lint:\s*allow\s+([\w-]+)\s*—\s*(.+)/g)) {
    const rule = match[1];
    const reason = match[2]?.trim();
    if (rule && reason && reason.length > 10) allowed.add(rule);
  }
  return allowed;
}

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
let violations = 0;

for (const file of files) {
  const raw = await readFile(join(migrationsDir, file), "utf8");
  const allowed = allowances(raw);
  const sql = stripComments(raw);

  for (const rule of RULES) {
    if (!violates(rule, sql)) continue;
    if (allowed.has(rule.name)) {
      console.log(`allowed · ${file} · ${rule.name} (documented exception)`);
      continue;
    }
    violations++;
    console.error(`VIOLATION · ${file} · ${rule.name}\n  ${rule.message}`);
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} violation(s). If a change is genuinely required, add:\n` +
      `  -- migration-lint: allow <rule-name> — <why this is safe>\n` +
      `and expect a second reviewer to ask about it.`,
  );
  process.exit(1);
}

console.log(`${files.length} migration(s) checked · no violations`);
