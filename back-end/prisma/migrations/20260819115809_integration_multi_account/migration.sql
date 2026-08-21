-- DropIndex
DROP INDEX "Integration_userId_name_key";

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "accountEmail" TEXT,
ADD COLUMN     "accountId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Integration_userId_name_accountId_key" ON "Integration"("userId", "name", "accountId");

