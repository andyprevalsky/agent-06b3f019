-- Restores the 20260821002002 index a stray `prisma db push` dropped from production.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_goal_trgm_idx"
ON "Agent" USING GIN ("goal" gin_trgm_ops);
