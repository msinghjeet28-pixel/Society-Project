# SocietyRecord

An append-only accountability record for housing societies. Every complaint,
expense, and rupee collected becomes part of one connected, tamper-evident
record — as a side effect of normal work.

MVP scope: 5 pilot Cooperative Group Housing Societies in Delhi NCR.

## Where the thinking lives

| Document | What it decides |
| --- | --- |
| PRD v1.2 (`~/Documents/Society Proj/MVP PRD.pdf`) | Product scope: 5 epics, 21 stories, NFRs |
| Epic 1 UX flows v1.2 | Screen-level flows for setup, login, roles, corrections |
| Architecture 0.3 | System shape, and six resolved product decisions |
| Tech Design 0.1 | Component design, evidence, critique, guardrails |

## Running it locally

Needs Node 22.18+ (type stripping runs unflagged from that version) and
PostgreSQL 16.

```bash
corepack enable && pnpm install

# Postgres
brew services start postgresql@16
createdb societyrecord_dev
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/societyrecord_dev"

pnpm db:migrate
pnpm --filter @sr/api dev      # http://localhost:3000/health
```

## The gates

`pnpm gates` runs the stack a PR must pass. Each gate defends a specific claim
from the tech design rather than general tidiness:

| Command | Defends |
| --- | --- |
| `pnpm -r typecheck` | Strict types across the entry envelope |
| `pnpm lint` | Money never touches a float (the money lint) |
| `pnpm depcruise` | Module boundaries; server code stays off the phone |
| `pnpm vitest run` | Immutability's four layers, chain integrity under concurrency, deny-by-default policy, gapless counters |
| `node --experimental-strip-types tools/lint-migrations.ts` | No migration can make a ledger table mutable |
| `node --experimental-strip-types tools/verify-chains.ts` | Every society's hash chain verifies (runs nightly on Render) |

## What "append-only" means in practice

Nothing is ever edited or deleted — not by a user, not by us. Enforced in four
layers, each catching what the one above cannot:

1. **API** — no `PUT`, `PATCH`, or `DELETE` route exists for a ledger entity.
2. **Privileges** — the app connects as `app_rw`, which holds only
   `SELECT, INSERT` on ledger tables.
3. **Triggers** — `BEFORE UPDATE OR DELETE` raises, catching privileged
   sessions including migrations and a psql prompt at 1 a.m.
4. **Hash chain** — each entry carries the previous entry's hash, per society.
   Any silent alteration breaks verification from that row forward, and the
   nightly job finds it.

Layer 4 is what makes the claim checkable rather than merely promised. To see
it work, tamper with a row directly (trigger disabled) and run
`tools/verify-chains.ts`: it names the exact entry and exits non-zero.

Corrections are new entries linked to the original, with a mandatory reason.
The original stays visible, forever.

Practical consequence worth knowing before you write a test: **teardown cannot
delete ledger rows.** Tests reset with `TRUNCATE` via the helpers in
`apps/api/test/helpers/db.ts`. Production appends forever; tests reset the
world.

## Deployment

Render blueprint in `render.yaml`: API, public page renderer, worker, and the
nightly chain-verification cron, plus managed Postgres.

The public renderer is a **separate service on purpose** — unauthenticated,
CDN-cacheable, and connected as `public_ro`, which can read only `public_*`
views. An unauthenticated request never reaches code that can write to the
ledger, and no template can leak a flat balance because the renderer's role
cannot select one.

**Open decision: region.** The PRD's NFR says "hosted in India" and the
architecture chose AWS Mumbai for that reason. Render has no India region.
`render.yaml` currently sets `singapore` as the closest option, pending the
call recorded as D-007 in [docs/DECISIONS.md](docs/DECISIONS.md).
