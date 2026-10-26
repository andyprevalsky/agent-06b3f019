-- NOT VALID constraints are metadata-only; existing rows are checked by the
-- next migration under a lock that does not block reads or writes.
-- The composite relation keeps MessageRecord.userId equal to Person.userId:
-- a mismatched insert fails and an owner change cascades.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "MessageRecord" DROP CONSTRAINT IF EXISTS "MessageRecord_personId_fkey";
ALTER TABLE "MessageRecord" ADD CONSTRAINT "MessageRecord_personId_userId_fkey"
  FOREIGN KEY ("personId", "userId") REFERENCES "Person"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "MessageRecord" ADD CONSTRAINT "MessageRecord_userId_not_null"
  CHECK ("userId" IS NOT NULL) NOT VALID;
