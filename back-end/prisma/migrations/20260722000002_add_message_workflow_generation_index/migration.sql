CREATE INDEX CONCURRENTLY "Message_agentId_workflowGeneration_timestamp_idx"
ON "Message"("agentId", "workflowGeneration", "timestamp");
