-- Persist fast-cache provider-family affinity so deterministic cache replays
-- use the same direct-token provider family across runs.

CREATE TABLE "ComputeTokenFastCacheAffinity" (
    "affinityKey" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeTokenFastCacheAffinity_pkey" PRIMARY KEY ("affinityKey")
);

CREATE INDEX "ComputeTokenFastCacheAffinity_tokenType_idx" ON "ComputeTokenFastCacheAffinity"("tokenType");
CREATE INDEX "ComputeTokenFastCacheAffinity_userId_idx" ON "ComputeTokenFastCacheAffinity"("userId");
