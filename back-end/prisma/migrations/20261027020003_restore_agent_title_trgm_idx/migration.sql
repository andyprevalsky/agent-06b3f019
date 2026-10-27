-- Restores the 20260821002001 index a stray `prisma db push` dropped from production.
-- If this build fails it leaves an INVALID index that IF NOT EXISTS would skip.
-- Recover with DROP INDEX CONCURRENTLY IF EXISTS "Agent_title_trgm_idx", then
-- `prisma migrate resolve --rolled-back` this migration and redeploy with the
-- statement timeout lifted for that session (DIRECT_URL with
-- options=-c%20statement_timeout%3D0): 20261027020001 stays applied, so the
-- redeploy does not rerun it. The post-deploy schema-object check fails on
-- INVALID indexes until then.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_title_trgm_idx"
ON "Agent" USING GIN ("title" gin_trgm_ops);
