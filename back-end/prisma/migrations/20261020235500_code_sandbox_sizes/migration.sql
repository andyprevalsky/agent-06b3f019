-- AlterTable
ALTER TABLE "CodeSession" ADD COLUMN     "sandboxCpu" INTEGER,
ADD COLUMN     "sandboxMemoryGb" INTEGER;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "sandboxSize" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "codeSandboxMaxCpu" INTEGER,
ADD COLUMN     "codeSandboxMaxMemoryGb" INTEGER;

-- CreateTable
CREATE TABLE "CodeSessionResize" (
    "id" TEXT NOT NULL,
    "codeSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT,
    "fromCpu" INTEGER NOT NULL,
    "fromMemoryGb" INTEGER NOT NULL,
    "toCpu" INTEGER NOT NULL,
    "toMemoryGb" INTEGER NOT NULL,
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

-- Backend-only bookkeeping: authenticated API owns reads and writes.
ALTER TABLE "CodeSessionResize" ENABLE ROW LEVEL SECURITY;
