ALTER TABLE "Agent"
ADD COLUMN "temporalFirstExecutionRunId" TEXT,
ADD COLUMN "workflowReplacementToken" TEXT,
ADD COLUMN "staleTemporalWorkflowId" TEXT,
ADD COLUMN "staleTemporalFirstExecutionRunId" TEXT;

CREATE INDEX "Agent_workflowReplacementToken_idx"
ON "Agent"("workflowReplacementToken");

ALTER TABLE "Message"
ADD COLUMN "workflowGeneration" TEXT;

CREATE INDEX "Message_agentId_workflowGeneration_timestamp_idx"
ON "Message"("agentId", "workflowGeneration", "timestamp");
