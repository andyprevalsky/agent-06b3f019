CREATE INDEX CONCURRENTLY IF NOT EXISTS "MessageRecord_userId_timestamp_idx"
ON "MessageRecord" ("userId", "timestamp");
