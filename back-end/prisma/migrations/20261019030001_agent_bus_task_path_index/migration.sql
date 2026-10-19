-- Path resolution and sibling-uniqueness lookups: one (busId, taskPath) probe.
CREATE INDEX CONCURRENTLY "Agent_busId_taskPath_idx" ON "Agent"("busId", "taskPath");
