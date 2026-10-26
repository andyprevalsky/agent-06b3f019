-- Restores the 20260821002002 index a stray `prisma db push` dropped from production.
-- If this build fails it leaves an INVALID index that IF NOT EXISTS would skip.
-- Recover with DROP INDEX CONCURRENTLY IF EXISTS "Agent_goal_trgm_idx", then
-- `prisma migrate resolve --rolled-back` this migration and redeploy. The
-- post-deploy schema-object check fails on INVALID indexes until then.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_goal_trgm_idx"
ON "Agent" USING GIN ("goal" gin_trgm_ops);
