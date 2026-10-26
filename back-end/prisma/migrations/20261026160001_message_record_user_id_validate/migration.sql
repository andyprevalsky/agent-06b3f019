-- VALIDATE scans under SHARE UPDATE EXCLUSIVE, which does not block reads or
-- writes. SET NOT NULL then reuses the validated CHECK instead of rescanning.
ALTER TABLE "MessageRecord" VALIDATE CONSTRAINT "MessageRecord_personId_userId_fkey";
ALTER TABLE "MessageRecord" VALIDATE CONSTRAINT "MessageRecord_userId_not_null";
ALTER TABLE "MessageRecord" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "MessageRecord" DROP CONSTRAINT "MessageRecord_userId_not_null";
