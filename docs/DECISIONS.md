# Decision log

Product decisions D-001 … D-006 were resolved by the PM on 30 Jul 2026 and are
recorded in full in Architecture 0.3 §14. They are summarised here because the
code implements them and a reader of the code should not have to open a
separate document to learn why.

D-007 onward are raised during the build.

---

## D-001 · Only an invite code may create a society
**Decided.** One single-use code per society, issued at pilot signing; it also
tags the acquisition channel. Post-pilot this becomes sales-assisted onboarding
rather than open self-serve.

*In the code:* `invite_code` table in `migrations/0001_ledger_core.sql`,
consumed inside the society-creation transaction.

## D-002 · Queued entries after a role is revoked
**Decided.** Two situations, two treatments, because the record must not blur
them:

- Created **before** revocation, synced after → enters automatically, honored,
  flagged `synced_after_role_ended`.
- `occurred_at` **after** revocation → does *not* auto-enter. It lands in a
  committee-confirmation queue. Confirmed entries enter with the flag; rejected
  ones stay permanently visible as rejected.

Device clocks are client-side, so an ex-staffer must not be able to write
unattended. Nothing is silently dropped either way.

*In the code:* `synced_after_role_ended` in `ENTRY_FLAGS`
(`packages/envelope/src/core/envelope.ts`); the sync verdict
`queued_confirmation`; `syncqueue.confirm` in the permissions table.

## D-003 · Proof links never expire
**Decided,** for the MVP. A question asked in March about a July expense still
gets its answer from the link in the group's history. Tokens stay individually
revocable, so a committee can kill one link without any expiry machinery.

## D-004 · What "device" means in the trail
**Decided.** Record the installation ID and login session on every entry; never
show either. User-facing copy reads *"Approved by Sudha Menon · 12 Jun,
7:40 AM · from her registered phone."* The raw installation ID appears only in
the full export — the Registrar-and-legal surface. Same principle as the
office-bearer vocabulary rule: legal terms live in legal documents.

*In the code:* `install_id` on every ledger row; no API response exposes it.

## D-005 · Retention versus privacy
**Decided,** in one sentence: **identity on transactions is the record;
reachability is personal data.**

Permanent — names on transactions, flat ledgers, receipts, approvals; the
lawful basis is the society's statutory duty to maintain books, and erasing a
name from a receipt would falsify the record. Erasable on request after exit —
phone number and messaging consent, once the committee confirms no live dues
dispute.

*In the code:* contact fields exist **only** on `person`, never denormalised
into ledger entries. Entries carry `actor_id`, `actor_name`, and
`actor_role` — all identity, no reachability. Erasure touches one row and zero
ledger entries, enforced by the `erased_means_no_phone` constraint.

## D-006 · Date fixed, scope flexes down a ladder
**Decided.** The 8–10 weeks is fixed. Descope order, agreed in advance so a
week-7 squeeze is a decision already made:

1. The three Should Haves — 2.5 committee complaints view, 3.5 fund tags,
   5.4 documents folder.
2. Story 4.3, the dues dashboard.
3. Only if still needed, the rest of Epic 4, restored in the first post-MVP
   sprint.

**Never on the table:** Epics 1–3, the expense story page (5.1), the
accountant export (5.3).

---

## D-007 · Hosting region — OPEN, needs a product call

**Raised** 30 Jul 2026 during build setup. **Blocks** nothing today; must be
settled before the first pilot society enters real data.

**The conflict.** PRD §7 (Security) states data is *"encrypted in transit and
at rest, hosted in India,"* and Architecture §11 chose AWS Mumbai
(`ap-south-1`) explicitly because *"'hosted in India' is a stated NFR and a
Delhi-CGHS trust argument."*

**Render has no India region.** Available: Oregon, Ohio, Virginia, Frankfurt,
Singapore. Singapore is the closest, roughly 40–60 ms further from Delhi than
Mumbai would be — immaterial for this product's performance budget, since the
3-second proof-page target is dominated by payload size, not round-trip time.

Latency is not the issue. The issue is that "hosted in India" was made as a
**promise to societies** and appears in the trust argument used to sell the
pilot.

**Options.**

1. **Singapore, and revise the NFR wording** to what is actually true (for
   example "encrypted in transit and at rest, hosted in Singapore under Indian
   data-protection law"). Cheapest. Requires the PM to accept that a stated
   trust claim changes, and to check it against whatever was said to pilot
   societies verbally.
2. **Keep Render for the app, move Postgres to an India-hosted provider**
   (Neon/Aiven/self-managed in Mumbai). Preserves the promise for the data
   itself, which is the part the promise is really about. Cost: cross-region
   database latency on every query, which for an append-heavy ledger with an
   advisory lock per society is a real slowdown, and a second vendor to operate.
3. **Move off Render to AWS Mumbai** as the architecture originally specified.
   Honours the promise exactly; costs the simplicity that made Render attractive
   and adds infrastructure work to a fixed 8–10 week window.

**My recommendation as tech lead: option 1 for the pilot, revisit before
scaling.** Five societies with assisted onboarding is the moment to learn
whether hosting location is something committees actually ask about. India's
DPDP Act permits cross-border transfer except to specifically restricted
countries, so this is a trust-and-messaging question rather than a legal
blocker — but it is *your* promise, so it is your call, and it should be made
before a treasurer types real money into the system rather than after.

Until decided, `render.yaml` sets `singapore` with a comment marking it a
placeholder, so nobody mistakes it for a settled choice.
