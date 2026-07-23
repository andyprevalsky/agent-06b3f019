ALTER TABLE "Agent"
ADD COLUMN "workflowReplacementState" JSONB,
ADD COLUMN "workflowMaxIterations" INTEGER,
ADD COLUMN "workflowContextGates" JSONB;
