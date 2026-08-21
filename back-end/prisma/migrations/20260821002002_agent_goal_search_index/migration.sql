CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_goal_trgm_idx"
ON "Agent" USING GIN ("goal" gin_trgm_ops);
