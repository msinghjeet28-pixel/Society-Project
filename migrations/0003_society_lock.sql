-- 0003 · Name the per-society lock, so read-check-append is atomic
--
-- Found by the revocation tests. The two-committee-member guard (Flow C4e)
-- reads a count, decides, then appends — and two concurrent revocations could
-- both read "three committee members" and both proceed, leaving one approver.
-- The society would have disabled itself through the exact door the guard
-- exists to hold shut.
--
-- Row locks cannot help: membership_active is a DISTINCT ON projection, and
-- Postgres refuses FOR SHARE on those. The lock that does work is the one the
-- chain already takes per society; this migration gives it a name so the key is
-- defined once and every caller takes the same one.

CREATE OR REPLACE FUNCTION lock_society(p_society uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_society::text, 0));
END $$;

COMMENT ON FUNCTION lock_society(uuid) IS
  'Serialises writes within one society for the duration of the transaction. '
  'Held by chain appends and by any read-check-append sequence such as the '
  'two-committee-member guard. Re-entrant: taking it twice in a transaction is '
  'a no-op.';

-- lock_chain now takes the lock through the shared function rather than
-- computing the key itself, so the two can never drift apart.
CREATE OR REPLACE FUNCTION lock_chain(p_society uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  head text;
BEGIN
  PERFORM lock_society(p_society);
  SELECT chain_head INTO head FROM society WHERE id = p_society;
  IF head IS NULL THEN
    RAISE EXCEPTION 'unknown society %', p_society;
  END IF;
  RETURN head;
END $$;

GRANT EXECUTE ON FUNCTION lock_society(uuid) TO app_rw;
