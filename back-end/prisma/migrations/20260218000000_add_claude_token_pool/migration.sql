-- Add pooling fields to Integration table
ALTER TABLE "Integration" ADD COLUMN "poolingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Integration" ADD COLUMN "rateLimitedUntil" TIMESTAMP(3);
ALTER TABLE "Integration" ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- Index for pool token queries (LRU ordering with rate-limit exclusion)
CREATE INDEX "Integration_poolingEnabled_rateLimitedUntil_idx" ON "Integration"("poolingEnabled", "rateLimitedUntil");
