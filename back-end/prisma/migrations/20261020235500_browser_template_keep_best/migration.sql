-- The user's browser template keeps every account and resolves collisions by
-- keep-best (plan row A6 rework). Authored with `prisma migrate diff` against
-- the A6 schema; the unrelated trigram-index drop Prisma emits was removed.
-- Additive columns plus a wider unique key on two tables that are not yet in
-- production, so no existing row is rewritten.

-- DropIndex
DROP INDEX "BrowserSiteState_userId_site_key";

-- AlterTable
ALTER TABLE "BrowserSiteFork" ADD COLUMN     "account" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "BrowserSiteState" ADD COLUMN     "account" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "authExpiresAt" TIMESTAMP(3),
ADD COLUMN     "observedAt" TIMESTAMP(3),
ADD COLUMN     "supersededFingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "validatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSiteState_userId_site_account_key" ON "BrowserSiteState"("userId", "site", "account");
