-- Support first-root-task cohort aggregation without sequential scans.
CREATE INDEX "Agent_parentAgentId_createdAt_idx" ON "Agent"("parentAgentId", "createdAt");
CREATE INDEX "GoalHistory_depth_agentCreatedAt_idx" ON "GoalHistory"("depth", "agentCreatedAt");
