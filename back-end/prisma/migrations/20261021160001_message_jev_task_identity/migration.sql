CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_jev_taskId_idx"
ON "Message" ("agentId", "workflowGeneration", (metadata #> ARRAY['taskId']::text[]));
