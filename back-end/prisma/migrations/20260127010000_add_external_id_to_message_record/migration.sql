-- Add externalId column for platform-native message IDs
ALTER TABLE "MessageRecord" ADD COLUMN "externalId" TEXT;

-- Drop the old timestamp-based unique constraint (causes issues with same-second messages)
DROP INDEX IF EXISTS "MessageRecord_personId_channel_timestamp_from_key";

-- Create new unique constraint on (personId, channel, externalId)
-- NULL values are treated as distinct in PostgreSQL, so old records without externalId won't conflict
CREATE UNIQUE INDEX "MessageRecord_personId_channel_externalId_key" ON "MessageRecord"("personId", "channel", "externalId");
