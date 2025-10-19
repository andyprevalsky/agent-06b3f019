-- CreateTable
CREATE TABLE "ModelPricingCache" (
    "modelId" TEXT NOT NULL,
    "tokenInPriceMicrodollars" INTEGER NOT NULL,
    "tokenOutPriceMicrodollars" INTEGER NOT NULL,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPricingCache_pkey" PRIMARY KEY ("modelId")
);

-- CreateIndex
CREATE INDEX "ModelPricingCache_expiresAt_idx" ON "ModelPricingCache"("expiresAt");

