-- Retain every historical binding; enforce one unresolved phone intent for all writer versions.
-- Install the stronger lifecycle constraint before removing the historical global unique index.
BEGIN;
  LOCK TABLE "ImessageQueue" IN SHARE ROW EXCLUSIVE MODE;
  CREATE UNIQUE INDEX IF NOT EXISTS "ImessageQueue_phoneBrowserTaskId_unresolved_key"
    ON "ImessageQueue"("phoneBrowserTaskId")
    WHERE "transport" = 'phone_harness' AND "phoneBrowserTaskId" IS NOT NULL
      AND "sentAt" IS NULL AND "failedAt" IS NULL;
  DROP INDEX IF EXISTS "ImessageQueue_phoneBrowserTaskId_key";
  CREATE INDEX IF NOT EXISTS "ImessageQueue_phoneBrowserTaskId_idx"
    ON "ImessageQueue"("phoneBrowserTaskId");
COMMIT;
