-- 0004 · Setup wizard, flats, and the one-time import
--
-- Story 1.1: set up a society in under thirty minutes. Societies under 30 flats
-- add rows directly; larger ones bring a flat list in through a one-time Excel
-- import, fix errors per row on screen, and never re-upload the file.
--
-- The edge case that shapes this migration: "a flat changes owner mid-pilot —
-- the flat's ledger continues, the new owner's tenure begins from the transfer
-- date, all history stays with the flat, not the person." That is why dues and
-- payments will reference flat_id, and why occupancy is a tenure table rather
-- than an owner column.

-- ---------------------------------------------------------------- flats
CREATE TABLE flat (
  id            uuid PRIMARY KEY,
  society_id    uuid NOT NULL REFERENCES society(id),
  -- Free text on purpose: real societies number flats A-101, 4/B, T2-1204.
  -- Normalising this would be a data-entry argument we cannot win.
  number        text NOT NULL CHECK (length(trim(number)) > 0),
  -- Captured once at setup and rolled forward monthly (Story 4.1). Kept on the
  -- flat because it is a standing amount, not a transaction.
  monthly_dues_paise bigint NOT NULL DEFAULT 0 CHECK (monthly_dues_paise >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Duplicate flat numbers must be impossible, not merely flagged. Story 1.1 · 4
-- says setup cannot complete with unresolved duplicates; this is that rule at
-- the level where it cannot be argued with.
CREATE UNIQUE INDEX flat_number_per_society ON flat(society_id, lower(trim(number)));

/**
 * Who occupied a flat, and when.
 *
 * A sale mid-pilot closes one tenure and opens the next. The ledger is
 * untouched: dues, payments and complaints reference the flat, so nothing has to
 * be migrated when a flat changes hands — which is the whole point of the
 * Story 1.1 edge case.
 */
CREATE TABLE owner_tenure (
  id            uuid PRIMARY KEY,
  flat_id       uuid NOT NULL REFERENCES flat(id),
  person_id     uuid NOT NULL REFERENCES person(id),
  began_on      date NOT NULL,
  ended_on      date,
  CONSTRAINT tenure_ends_after_it_begins CHECK (ended_on IS NULL OR ended_on >= began_on)
);

-- One current occupant per flat. A flat with two live tenures is a bug that
-- would quietly send one owner's receipt to another.
CREATE UNIQUE INDEX flat_one_current_tenure ON owner_tenure(flat_id)
  WHERE ended_on IS NULL;

CREATE INDEX owner_tenure_person ON owner_tenure(person_id);

-- ---------------------------------------------------------------- wizard drafts
/**
 * Setup is autosaved per step (Flow A5–A9).
 *
 * The thirty-minute promise is really an interruption-proof promise: a working
 * volunteer does this across two evenings, and a draft held in app memory loses
 * everything when a phone rings. So each step writes here, and nothing reaches
 * the ledger until the wizard commits.
 */
CREATE TABLE society_draft (
  id              uuid PRIMARY KEY,
  -- The number that started setup. Not a person row yet: no society exists to
  -- belong to, which is exactly the state Flow A4 describes.
  started_by_phone text NOT NULL CHECK (started_by_phone ~ '^\+[1-9][0-9]{7,14}$'),
  invite_code     text NOT NULL REFERENCES invite_code(code),
  step            integer NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 5),
  -- One JSON blob per step rather than fifty nullable columns. A draft is
  -- scratch space; its shape changes as the wizard does, and it is deleted on
  -- commit. Validation happens at the step boundary in the API, and again at
  -- commit against the real constraints.
  basics          jsonb,
  committee       jsonb,
  staff           jsonb,
  flats           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz,
  society_id      uuid REFERENCES society(id)
);

CREATE INDEX society_draft_phone ON society_draft(started_by_phone) WHERE committed_at IS NULL;

-- One live draft per invite code: the code is single-use, so two half-finished
-- societies claiming it is a state we should never have to reason about.
CREATE UNIQUE INDEX society_draft_one_per_code ON society_draft(invite_code)
  WHERE committed_at IS NULL;

/**
 * Continuing setup on a computer (Flow A8b).
 *
 * Editing 92 rows on a phone is a punishment, so the wizard offers a link. It is
 * single-use and short-lived: it grants the power to finish creating a society.
 */
CREATE TABLE draft_handoff_token (
  token_hash    bytea PRIMARY KEY,
  draft_id      uuid NOT NULL REFERENCES society_draft(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);

-- ---------------------------------------------------------------- import staging
/**
 * The one-time Excel import (Story 1.1 · 3–4).
 *
 * Rows land here, are validated per row, and the errors are fixed on screen —
 * the file is never re-uploaded, because re-uploading after fixing one cell is
 * where setup funnels die. Only when every row resolves does a single
 * transaction move them into `flat`.
 */
CREATE TABLE import_row (
  id              uuid PRIMARY KEY,
  draft_id        uuid NOT NULL REFERENCES society_draft(id) ON DELETE CASCADE,
  -- The row number in the file the treasurer uploaded, so "3 of 92 rows need
  -- attention" can point at the right one.
  source_line     integer NOT NULL CHECK (source_line > 0),
  flat_number     text,
  owner_name      text,
  phone_e164      text,
  monthly_dues_paise bigint,
  -- Populated by validation; empty array means the row is clean. Errors are
  -- data, not exceptions: the fix-it screen renders them.
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixed_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_row_draft ON import_row(draft_id, source_line);
CREATE INDEX import_row_unresolved ON import_row(draft_id)
  WHERE jsonb_array_length(errors) > 0;

-- ---------------------------------------------------------------- corrections
/**
 * Correction support on the shared envelope (Arch §12, Tech Design §06).
 *
 * Built now, in Epic 1, rather than when Epic 3 first needs to correct an
 * expense: the envelope makes this one implementation for every entity, and
 * discovering in week six that four entity types each need bespoke handling
 * costs weeks.
 *
 * membership_event gains the columns every ledger table carries. The CHECK is
 * what makes the mandatory reason a property of the data rather than a rule in
 * whichever screen happened to ask.
 */
ALTER TABLE membership_event
  ADD COLUMN corrects_id uuid REFERENCES membership_event(id),
  ADD COLUMN correct_reason text,
  -- The IS NOT NULL is load-bearing, not defensive noise. Written as
  -- `length(trim(correct_reason)) > 0` alone, a NULL reason makes the whole
  -- expression NULL, and a CHECK only rejects FALSE — so the constraint would
  -- pass in precisely the case it exists to catch. The test that inserts a
  -- reasonless correction found this; nothing else would have.
  ADD CONSTRAINT correction_needs_reason
    CHECK (
      corrects_id IS NULL
      OR (correct_reason IS NOT NULL AND length(trim(correct_reason)) > 0)
    ),
  -- An entry cannot correct itself.
  ADD CONSTRAINT correction_is_not_self CHECK (corrects_id IS NULL OR corrects_id <> id);

-- One correction per original. A second attempt corrects the correction, which
-- keeps the chain of corrections legible instead of producing rival versions of
-- the same fix (Tech Design §06 critique).
CREATE UNIQUE INDEX membership_event_one_correction ON membership_event(corrects_id)
  WHERE corrects_id IS NOT NULL;

/**
 * The honest pair the UX promises (Flow D3), as a projection.
 *
 * `is_corrected` is DERIVED from the existence of a correction rather than
 * written onto the original — the original is immutable, including its status.
 */
CREATE VIEW membership_event_current AS
SELECT e.*,
       (c.id IS NOT NULL)          AS is_corrected,
       c.id                        AS corrected_by,
       c.correct_reason            AS correction_reason
  FROM membership_event e
  LEFT JOIN membership_event c ON c.corrects_id = e.id;

-- ---------------------------------------------------------------- outbox support
/**
 * Client-declared dependencies between queued entries (Tech Design §04 critique).
 *
 * A batch can carry "create complaint" followed by "its own status event". If
 * the create is rejected, the event must be rejected too rather than applied
 * against a missing parent. The client sets this; the server honours it.
 */
ALTER TABLE membership_event
  ADD COLUMN depends_on uuid;

/**
 * Entries that arrived claiming a moment after their author's role ended
 * (Arch §14 №2, decision D-002).
 *
 * Device clocks are client-side, so these do not auto-enter. They wait here for
 * a committee member to confirm or reject. Confirmed entries join the ledger
 * with the flag; rejected ones remain permanently visible as rejected. Nothing
 * is silently dropped either way.
 */
CREATE TABLE queued_entry (
  id            uuid PRIMARY KEY,
  society_id    uuid NOT NULL REFERENCES society(id),
  actor_id      uuid NOT NULL REFERENCES person(id),
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL CHECK (reason IN ('after_role_ended', 'clock_skew_high')),
  clock_skew_ms bigint NOT NULL DEFAULT 0,
  install_id    uuid NOT NULL,
  -- Resolution
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES person(id),
  resolution    text CHECK (resolution IN ('confirmed', 'rejected')),
  resolution_note text,
  CONSTRAINT resolution_is_complete
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

CREATE INDEX queued_entry_pending ON queued_entry(society_id, received_at)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------- grants
/**
 * flat and owner_tenure are RECORDS, not ledger entries — deliberately, and the
 * distinction is worth stating because getting it wrong is expensive both ways.
 *
 * A ledger entry is a claim about something that happened at a moment: this
 * expense, that payment, this role granted. Those are immutable because
 * changing them rewrites history.
 *
 * A flat is a thing that exists. Its standing monthly dues are its current
 * configuration, and a committee raising them next year is not a correction of
 * anything — it is the world changing. Closing a tenure when a flat is sold is
 * the same. Making these immutable would mean a dues revision needs a whole
 * parallel event stream to express something the schema can say directly.
 *
 * What makes that safe is the rule the architecture already fixed: each
 * DUES_LINE records the amount it billed, and each ALLOCATION records the split
 * it settled. No ledger entry's meaning depends on a flat's current dues, so
 * changing them cannot silently rewrite what a receipt claimed. That is why the
 * immutability trigger belongs on the entries and not on these two tables.
 */
GRANT SELECT, INSERT, UPDATE ON flat TO app_rw;
GRANT SELECT, INSERT, UPDATE ON owner_tenure TO app_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON society_draft TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_row TO app_rw;
GRANT SELECT, INSERT, UPDATE ON draft_handoff_token TO app_rw;
GRANT SELECT, INSERT, UPDATE ON queued_entry TO app_rw;
GRANT SELECT ON membership_event_current TO app_rw;

-- Drafts and import rows are scratch space, deliberately deletable: they are
-- not part of any society's record, and a discarded setup should leave nothing
-- behind. The ledger's promise begins at commit.
