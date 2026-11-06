-- Retain the historical unique index until this constraint is valid.
-- Deliberately no IF NOT EXISTS: an interrupted INVALID index must stop retry
-- before the next migration can drop the historical constraint.
CREATE UNIQUE INDEX CONCURRENTLY "ImessageQueue_phoneBrowserTaskId_unresolved_key"
  ON "ImessageQueue"("phoneBrowserTaskId")
  WHERE "transport" = 'phone_harness' AND "phoneBrowserTaskId" IS NOT NULL
    AND "sentAt" IS NULL AND "failedAt" IS NULL;
