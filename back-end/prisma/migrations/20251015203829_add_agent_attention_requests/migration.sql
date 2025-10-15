-- CreateTable
CREATE TABLE "AgentAttentionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" JSONB,
    "userResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAttentionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAttentionRequest_updatedAt_idx" ON "AgentAttentionRequest"("updatedAt");

-- CreateIndex
CREATE INDEX "AgentAttentionRequest_userId_idx" ON "AgentAttentionRequest"("userId");

-- CreateIndex
CREATE INDEX "AgentAttentionRequest_workflowId_idx" ON "AgentAttentionRequest"("workflowId");
