-- Denormalize the owner onto MessageRecord so per-user reads are served by
-- (userId, timestamp) instead of joining Person for every user's rows.
-- Split across migrations so no step holds a blocking lock while it scans:
-- this one adds and backfills; 160001 validates; 160002 indexes concurrently.

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

UPDATE "MessageRecord" m
SET "userId" = p."userId"
FROM "Person" p
WHERE p.id = m."personId" AND m."userId" IS NULL;

CREATE UNIQUE INDEX "Person_id_userId_key" ON "Person"("id", "userId");

-- The composite relation keeps MessageRecord.userId equal to Person.userId:
-- a mismatched insert fails and an owner change cascades.
ALTER TABLE "MessageRecord" DROP CONSTRAINT IF EXISTS "MessageRecord_personId_fkey";
ALTER TABLE "MessageRecord" ADD CONSTRAINT "MessageRecord_personId_userId_fkey"
  FOREIGN KEY ("personId", "userId") REFERENCES "Person"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "MessageRecord" ADD CONSTRAINT "MessageRecord_userId_not_null"
  CHECK ("userId" IS NOT NULL) NOT VALID;
