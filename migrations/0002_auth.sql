-- 0002 · Authentication and membership projection
--
-- Story 1.2: log in with a phone number and a one-time code, under thirty
-- seconds, no password to forget. Story 1.3: revocation takes effect on the
-- server immediately, independent of the device.

-- ---------------------------------------------------------------- OTP
-- Codes are stored hashed. A support engineer reading this table must not be
-- able to log in as a treasurer, and neither must a leaked backup.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY,
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash     bytea NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Delivery channel, so the voice fallback after two failures is on the
  -- record rather than inferred (Flow A3).
  channel       text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'voice', 'manual')),
  request_ip    inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  CONSTRAINT expiry_after_creation CHECK (expires_at > created_at)
);

-- Rate limiting reads this index, so it must be cheap.
CREATE INDEX otp_challenge_phone_recent ON otp_challenge(phone_e164, created_at DESC);
CREATE INDEX otp_challenge_ip_recent ON otp_challenge(request_ip, created_at DESC)
  WHERE request_ip IS NOT NULL;

-- ---------------------------------------------------------------- sessions
-- Long-lived tokens and instant revocation are contradictory. The resolution:
-- a short access token carrying the membership version it was minted with,
-- plus a refresh row the server can delete (Arch §07).
CREATE TABLE refresh_token (
  id            uuid PRIMARY KEY,
  token_hash    bytea NOT NULL UNIQUE,
  person_id     uuid NOT NULL REFERENCES person(id),
  society_id    uuid NOT NULL REFERENCES society(id),
  install_id    uuid NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

CREATE INDEX refresh_token_person ON refresh_token(person_id, society_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- projections
-- Current role is derived from the event stream, never stored as a mutable
-- column (Arch §05). DISTINCT ON takes the latest event per person per
-- society; entry_hash breaks ties deterministically when two events share a
-- recorded_at, which concurrent appends can produce.
CREATE VIEW membership_current AS
SELECT DISTINCT ON (society_id, person_id)
       society_id,
       person_id,
       role,
       committee_seat,
       kind,
       occurred_at   AS effective_at,
       recorded_at
  FROM membership_event
 ORDER BY society_id, person_id, recorded_at DESC, entry_hash DESC;

COMMENT ON VIEW membership_current IS
  'Latest membership event per person per society. kind = granted means active.';

-- Who may act right now.
CREATE VIEW membership_active AS
SELECT society_id, person_id, role, committee_seat, effective_at
  FROM membership_current
 WHERE kind = 'granted';

-- The moment a person lost access, used by the sync rule in D-002: entries
-- created before this apply with a flag; entries claiming to have occurred
-- after it go to the committee-confirmation queue.
CREATE VIEW membership_revoked_at AS
SELECT society_id, person_id, effective_at AS revoked_at
  FROM membership_current
 WHERE kind = 'revoked';

-- Guards the two-committee-member invariant (Flow C4e) in one place, so the
-- rule lives with the data rather than in whichever screen asks the question.
CREATE OR REPLACE FUNCTION active_committee_count(p_society uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM membership_active
   WHERE society_id = p_society AND role = 'committee';
$$;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON otp_challenge TO app_rw;
GRANT SELECT, INSERT, UPDATE ON refresh_token TO app_rw;
GRANT SELECT ON membership_current, membership_active, membership_revoked_at TO app_rw;
GRANT EXECUTE ON FUNCTION active_committee_count(uuid) TO app_rw;

-- otp_challenge and refresh_token are session machinery, not ledger entries:
-- attempts increment and tokens are revoked, so they are mutable by design.
-- Nothing about a society's record lives here.
