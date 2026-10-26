-- Restores the 20260821002003 index a stray `prisma db push` dropped from production.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_text_trgm_idx"
ON "Message" USING GIN ("text" gin_trgm_ops);
