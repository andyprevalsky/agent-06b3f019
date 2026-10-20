-- L-APPS2 (Rose-in-Rose follow-ups).
-- UserUiVersion: which code agent + task published a version (nullable; older
-- rows stay null). PreviewHandoffCode: one-time preview sign-in codes, stored
-- as SHA-256 only. Both are additive: no existing row is rewritten.

-- AlterTable
ALTER TABLE "UserUiVersion" ADD COLUMN     "publishedByAgentId" TEXT,
ADD COLUMN     "publishedByTaskId" TEXT;

-- CreateTable
CREATE TABLE "PreviewHandoffCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewHandoffCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewHandoffCode_codeHash_key" ON "PreviewHandoffCode"("codeHash");

-- CreateIndex
CREATE INDEX "PreviewHandoffCode_userId_expiresAt_idx" ON "PreviewHandoffCode"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "PreviewHandoffCode" ADD CONSTRAINT "PreviewHandoffCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only: codes are minted and redeemed by the service role through the
-- authenticated API, so no client policy is granted (no client can read a
-- code hash).
ALTER TABLE "PreviewHandoffCode" ENABLE ROW LEVEL SECURITY;

