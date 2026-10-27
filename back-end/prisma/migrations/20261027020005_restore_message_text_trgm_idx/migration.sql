-- Restores the 20260821002003 index a stray `prisma db push` dropped from production.
-- If this build fails it leaves an INVALID index that IF NOT EXISTS would skip.
-- Recover with DROP INDEX CONCURRENTLY IF EXISTS "Message_text_trgm_idx", then
-- `prisma migrate resolve --rolled-back` this migration and redeploy. The
-- post-deploy schema-object check fails on INVALID indexes until then.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_text_trgm_idx"
ON "Message" USING GIN ("text" gin_trgm_ops);
