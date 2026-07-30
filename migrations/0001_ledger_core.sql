-- 0001 · Ledger core
--
-- Immutability is declared in the schema, not the service (Arch §04):
--   layer 2  REVOKE UPDATE/DELETE/TRUNCATE from the app role
--   layer 3  triggers, to catch privileged sessions
--   layer 4  per-society hash chain, to catch even us
--
-- Layer 1 (no PUT/PATCH/DELETE routes) lives in the API.

-- ---------------------------------------------------------------- roles
-- Render's managed Postgres gives us an owner role, not a superuser. These
-- roles are created by the owner and are what the apps actually connect as.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_ro') THEN
    CREATE ROLE public_ro NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION raise_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger entries are append-only: % on %.% is refused',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'record a correction entry instead (corrects_id + correct_reason)';
END $$;

COMMENT ON FUNCTION raise_immutable() IS
  'Backstop for Arch §04 layer 3. Fires for privileged sessions that bypass REVOKE.';

-- Applies the full append-only treatment to a table. Called once per ledger
-- table so the four layers can never be half-applied by hand.
CREATE OR REPLACE FUNCTION make_ledger_table(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tname text := tbl::text;
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', tname);
  EXECUTE format('GRANT SELECT, INSERT ON %s TO app_rw', tname);
  EXECUTE format(
    'CREATE TRIGGER %s_immutable BEFORE UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION raise_immutable()',
    replace(tname, '.', '_'), tname);
END $$;

-- ---------------------------------------------------------------- society
CREATE TABLE society (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  -- MVP supports only Cooperative Group Housing Society (Delhi launch).
  society_type       text NOT NULL DEFAULT 'cghs' CHECK (society_type = 'cghs'),
  flat_count         integer NOT NULL CHECK (flat_count > 0),
  message_language   text NOT NULL CHECK (message_language IN ('en', 'hi')),
  -- Staff cash limit, set at setup. Per-society policy value, enforced at the
  -- expense write, never only in the UI (Story 1.3 · 2).
  staff_cash_limit_paise bigint NOT NULL DEFAULT 200000
                         CHECK (staff_cash_limit_paise >= 0),
  -- The import path closes permanently once setup commits (Story 1.1 · 5).
  import_closed_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Chain head, advanced under an advisory lock (see append_ledger_entry).
  chain_head         text NOT NULL DEFAULT repeat('0', 64)
                     CHECK (chain_head ~ '^[0-9a-f]{64}$')
);

-- Single-use invite codes gate society creation (Arch §14 №1). Consumed inside
-- the creation transaction, and they tag the acquisition channel.
CREATE TABLE invite_code (
  code           text PRIMARY KEY CHECK (length(code) BETWEEN 6 AND 32),
  channel        text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  consumed_at    timestamptz,
  consumed_by    uuid REFERENCES society(id)
);

CREATE UNIQUE INDEX invite_code_one_society ON invite_code(consumed_by)
  WHERE consumed_by IS NOT NULL;

-- ---------------------------------------------------------------- people
-- Contact details live ONLY here and are never denormalised into ledger
-- entries: "identity on transactions is the record; reachability is personal
-- data" (Arch §14 №5). Erasure touches this row and zero ledger entries.
CREATE TABLE person (
  id             uuid PRIMARY KEY,
  society_id     uuid NOT NULL REFERENCES society(id),
  display_name   text NOT NULL CHECK (length(trim(display_name)) > 0),
  phone_e164     text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_erased_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erased_means_no_phone
    CHECK (contact_erased_at IS NULL OR phone_e164 IS NULL)
);

-- One phone number per society. A number may hold roles in several societies
-- (Prakash, nine societies — Story 1.2 · 3).
CREATE UNIQUE INDEX person_phone_per_society
  ON person(society_id, phone_e164) WHERE phone_e164 IS NOT NULL;

-- Roles as an event stream, not a mutable column (Arch §05). Current role is a
-- projection; revocation is an append, and "who added whom, as what, when" is
-- answerable for free.
CREATE TABLE membership_event (
  id             uuid PRIMARY KEY,
  society_id     uuid NOT NULL REFERENCES society(id),
  person_id      uuid NOT NULL REFERENCES person(id),
  kind           text NOT NULL CHECK (kind IN ('granted', 'revoked')),
  role           text NOT NULL CHECK (role IN ('committee','staff','accountant','member')),
  committee_seat text CHECK (committee_seat IN ('president','secretary','treasurer')),
  -- envelope
  actor_id       uuid NOT NULL,
  actor_name     text NOT NULL,
  actor_role     text NOT NULL,
  install_id     uuid NOT NULL,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  clock_skew_ms  bigint NOT NULL DEFAULT 0,
  prev_hash      text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash     text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT seat_only_for_committee
    CHECK (committee_seat IS NULL OR role = 'committee')
);

CREATE INDEX membership_event_person ON membership_event(society_id, person_id, recorded_at);

-- Bumped on ANY role change in the society. A short access token carries the
-- value it was minted with; a mismatch is a 401, so revocation bites within
-- seconds on every device (Arch §07).
CREATE TABLE membership_version (
  society_id     uuid PRIMARY KEY REFERENCES society(id),
  version        bigint NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- counters
-- Gapless per-society numbering (Arch §10, Tech Design §05). A locked counter
-- row, never a sequence: sequences skip numbers on rollback, and a receipt
-- book with holes is what an auditor questions first.
CREATE TABLE counter (
  society_id     uuid NOT NULL REFERENCES society(id),
  kind           text NOT NULL CHECK (kind IN ('receipt', 'complaint')),
  next_value     bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (society_id, kind)
);

CREATE OR REPLACE FUNCTION issue_number(p_society uuid, p_kind text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  -- FOR UPDATE inside the caller's transaction: a rollback rolls the number
  -- back with it, so gaplessness is structural rather than cleaned up later.
  SELECT next_value INTO n FROM counter
    WHERE society_id = p_society AND kind = p_kind
    FOR UPDATE;
  IF n IS NULL THEN
    RAISE EXCEPTION 'no % counter for society %', p_kind, p_society;
  END IF;
  UPDATE counter SET next_value = next_value + 1
    WHERE society_id = p_society AND kind = p_kind;
  RETURN n;
END $$;

-- ---------------------------------------------------------------- chain
-- Fixes the fork the Tech Design §02 critique found: two concurrent appends in
-- one society could both read the same chain head and claim the same
-- prev_hash. The advisory lock serialises only the linking step, ~1ms, and is
-- released at transaction end.
CREATE OR REPLACE FUNCTION lock_chain(p_society uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  head text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_society::text, 0));
  SELECT chain_head INTO head FROM society WHERE id = p_society;
  IF head IS NULL THEN
    RAISE EXCEPTION 'unknown society %', p_society;
  END IF;
  RETURN head;
END $$;

CREATE OR REPLACE FUNCTION advance_chain(p_society uuid, p_entry_hash text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE society SET chain_head = p_entry_hash WHERE id = p_society;
END $$;

COMMENT ON FUNCTION lock_chain(uuid) IS
  'Take the per-society append lock and return the current chain head. '
  'Callers MUST call advance_chain in the same transaction.';

-- ---------------------------------------------------------------- apply layers
SELECT make_ledger_table('membership_event');

-- society/person/counter are mutable by design (chain_head advances, contact
-- erasure, counter increments). They are records ABOUT the ledger, not entries
-- IN it. Ledger tables get the trigger; these do not.
GRANT SELECT, INSERT, UPDATE ON society TO app_rw;
GRANT SELECT, INSERT, UPDATE ON person TO app_rw;
GRANT SELECT, INSERT, UPDATE ON counter TO app_rw;
GRANT SELECT, INSERT, UPDATE ON membership_version TO app_rw;
GRANT SELECT, INSERT, UPDATE ON invite_code TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT EXECUTE ON FUNCTION issue_number(uuid, text) TO app_rw;
GRANT EXECUTE ON FUNCTION lock_chain(uuid) TO app_rw;
GRANT EXECUTE ON FUNCTION advance_chain(uuid, text) TO app_rw;

-- public_ro gets nothing here. It receives SELECT on public_* views only,
-- created in the migration that adds them — so the renderer cannot read a
-- balance or a phone number even if a future template asks for one (Arch §08).
GRANT USAGE ON SCHEMA public TO public_ro;
