-- DropIndex
DROP INDEX "ClaudeCodeSession_sandboxId_key";

-- AlterTable
ALTER TABLE "ClaudeCodeSession" ADD COLUMN     "awaitingParent" JSONB,
ADD COLUMN     "codeProvider" TEXT,
ADD COLUMN     "codeSessionId" TEXT;

-- CreateTable
CREATE TABLE "CodeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rootAgentId" TEXT NOT NULL,
    "ownerAgentId" TEXT NOT NULL,
    "repoUrl" TEXT,
    "repoKey" TEXT NOT NULL DEFAULT '',
    "codeProvider" TEXT NOT NULL DEFAULT 'claude',
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sandboxKind" TEXT,
    "sandboxId" TEXT,
    "homeDir" TEXT,
    "cliSessionId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "latestCheckpointSeq" INTEGER NOT NULL DEFAULT 0,
    "nextCheckpointSeq" INTEGER NOT NULL DEFAULT 0,
    "lastRepoFacts" JSONB,
    "branch" TEXT,
    "baseBranch" TEXT,
    "mergeTarget" TEXT,
    "parentCodeSessionId" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CodeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSessionShare" (
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sharedWithAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSessionShare_pkey" PRIMARY KEY ("agentId")
);

-- CreateIndex
CREATE INDEX "CodeSession_userId_ownerAgentId_repoKey_lastActiveAt_idx" ON "CodeSession"("userId", "ownerAgentId", "repoKey", "lastActiveAt" DESC);

-- CreateIndex
CREATE INDEX "CodeSession_userId_state_lastActiveAt_idx" ON "CodeSession"("userId", "state", "lastActiveAt");

-- CreateIndex
CREATE INDEX "CodeSessionShare_sharedWithAgentId_idx" ON "CodeSessionShare"("sharedWithAgentId");

-- CreateIndex
CREATE INDEX "ClaudeCodeSession_codeSessionId_idx" ON "ClaudeCodeSession"("codeSessionId");

-- Per-user scoping: clients only ever read their own rows; the backend
-- (service role) owns every write.
ALTER TABLE "CodeSession" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can select own data" ON "CodeSession" FOR SELECT USING (((auth.uid())::text = "userId"));
ALTER TABLE "CodeSessionShare" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can select own data" ON "CodeSessionShare" FOR SELECT USING (((auth.uid())::text = "userId"));
