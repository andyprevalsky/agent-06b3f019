ALTER TABLE "Agent" ADD COLUMN "progressEstimate" JSONB,
  ADD COLUMN "progressEstimateGeneration" TEXT;
CREATE TABLE "AgentTaskProgressEstimate" (
  "agentId" TEXT NOT NULL,
  "workflowGeneration" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "estimate" JSONB NOT NULL,
  CONSTRAINT "AgentTaskProgressEstimate_pkey" PRIMARY KEY ("agentId", "workflowGeneration", "taskId"),
  CONSTRAINT "AgentTaskProgressEstimate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
