ALTER TABLE "Agent"
ADD COLUMN "temporalFirstExecutionRunId" TEXT,
ADD COLUMN "workflowReplacementToken" TEXT,
ADD COLUMN "staleTemporalWorkflowId" TEXT,
ADD COLUMN "staleTemporalFirstExecutionRunId" TEXT;

ALTER TABLE "Message"
ADD COLUMN "workflowGeneration" TEXT;
