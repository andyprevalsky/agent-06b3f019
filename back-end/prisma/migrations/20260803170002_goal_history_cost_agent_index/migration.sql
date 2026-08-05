CREATE INDEX CONCURRENTLY "Agent_parentAgentId_worldModelMode_createdAt_idx"
ON "Agent"("parentAgentId", "worldModelMode", "createdAt");
