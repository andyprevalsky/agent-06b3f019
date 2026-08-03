ALTER TABLE "GoalHistory"
ADD COLUMN "worldModelMode" TEXT NOT NULL DEFAULT 'real',
ADD COLUMN "wasAgentRun" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "costTelemetry" JSONB,
ADD COLUMN "costCapturedAt" TIMESTAMP(3);

CREATE INDEX "GoalHistory_wasAgentRun_worldModelMode_agentCreatedAt_idx"
ON "GoalHistory"("wasAgentRun", "worldModelMode", "agentCreatedAt");

CREATE INDEX "Agent_parentAgentId_worldModelMode_createdAt_idx"
ON "Agent"("parentAgentId", "worldModelMode", "createdAt");
