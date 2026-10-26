-- Denormalize the owner onto MessageRecord so per-user reads are served by
-- (userId, timestamp) instead of joining Person for every user's rows.
-- The rollout is split so no migration scans a table while holding a lock
-- that blocks reads or writes: add (metadata only) -> backfill (row locks) ->
-- unique Person index (concurrent) -> NOT VALID constraints (metadata only)
-- -> validate (non-blocking) and SET NOT NULL -> concurrent index changes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "MessageRecord" ADD COLUMN "userId" TEXT;

-- The previous release keeps inserting without userId until cutover finishes.
-- Fill it from Person so those rows are neither rejected nor invisible.
CREATE OR REPLACE FUNCTION "message_record_fill_user_id"() RETURNS trigger AS $$
BEGIN
  SELECT p."userId" INTO NEW."userId" FROM "Person" p WHERE p.id = NEW."personId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MessageRecord_fill_user_id"
BEFORE INSERT ON "MessageRecord"
FOR EACH ROW WHEN (NEW."userId" IS NULL)
EXECUTE FUNCTION "message_record_fill_user_id"();
