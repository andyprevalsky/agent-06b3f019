-- Restores the 20260821002001 index a stray `prisma db push` dropped from production.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_title_trgm_idx"
ON "Agent" USING GIN ("title" gin_trgm_ops);
