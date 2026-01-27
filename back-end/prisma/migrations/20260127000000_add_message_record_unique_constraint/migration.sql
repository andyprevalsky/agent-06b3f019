-- Delete duplicate MessageRecord entries (keep the first one by createdAt)
DELETE FROM "MessageRecord" a
USING "MessageRecord" b
WHERE a."createdAt" > b."createdAt"
  AND a."personId" = b."personId"
  AND a."channel" = b."channel"
  AND a."timestamp" = b."timestamp"
  AND a."from" = b."from";

-- Add unique constraint to prevent future duplicates
CREATE UNIQUE INDEX "MessageRecord_personId_channel_timestamp_from_key" ON "MessageRecord"("personId", "channel", "timestamp", "from");
