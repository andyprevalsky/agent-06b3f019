-- AlterTable
ALTER TABLE "CodeSession" ADD COLUMN     "sandboxTier" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "sandboxSize" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "codeSandboxMaxTier" TEXT;

-- CreateTable
CREATE TABLE "CodeSessionResize" (
    "id" TEXT NOT NULL,
    "codeSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT,
    "fromTier" TEXT NOT NULL,
    "toTier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "newTaskId" TEXT,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSessionResize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSessionResize_codeSessionId_requestedAt_idx" ON "CodeSessionResize"("codeSessionId", "requestedAt" DESC);

