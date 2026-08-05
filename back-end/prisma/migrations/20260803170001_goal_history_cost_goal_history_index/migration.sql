CREATE INDEX CONCURRENTLY "GoalHistory_wasAgentRun_worldModelMode_agentCreatedAt_idx"
ON "GoalHistory"("wasAgentRun", "worldModelMode", "agentCreatedAt");
