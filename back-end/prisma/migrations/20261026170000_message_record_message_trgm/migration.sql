CREATE INDEX CONCURRENTLY IF NOT EXISTS "MessageRecord_message_trgm_idx"
ON "MessageRecord" USING GIN ("message" gin_trgm_ops);
