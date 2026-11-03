-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activeUiVersionId" TEXT;

-- CreateTable
CREATE TABLE "UserUiVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserUiVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserUiVersion_userId_createdAt_idx" ON "UserUiVersion"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserUiVersion" ADD CONSTRAINT "UserUiVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user scoping: clients only ever read their own versions; the backend
-- (service role) owns every write.
ALTER TABLE "UserUiVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can select own data" ON "UserUiVersion" FOR SELECT USING (((auth.uid())::text = "userId"));
