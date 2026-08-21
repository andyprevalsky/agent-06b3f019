CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_title_trgm_idx"
ON "Agent" USING GIN ("title" gin_trgm_ops);
