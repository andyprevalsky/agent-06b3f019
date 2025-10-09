-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('STARTING_UP', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerifierType" AS ENUM ('FLOAT_LLM_JUDGE');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('SYSTEM', 'AGENT', 'USER', 'TOOL', 'STATUS');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "status" "AgentStatus" NOT NULL DEFAULT 'STARTING_UP',
    "statusMessage" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTool" (
    "agentId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("agentId","toolId")
);

-- CreateTable
CREATE TABLE "Verifier" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "VerifierType" NOT NULL DEFAULT 'FLOAT_LLM_JUDGE',
    "llmJudgePrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "text" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_userId_deletedAt_idx" ON "Agent"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Agent_createdAt_idx" ON "Agent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_name_key" ON "Tool"("name");

-- CreateIndex
CREATE INDEX "AgentTool_agentId_idx" ON "AgentTool"("agentId");

-- CreateIndex
CREATE INDEX "AgentTool_toolId_idx" ON "AgentTool"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "Verifier_agentId_key" ON "Verifier"("agentId");

-- CreateIndex
CREATE INDEX "Message_agentId_timestamp_idx" ON "Message"("agentId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verifier" ADD CONSTRAINT "Verifier_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
