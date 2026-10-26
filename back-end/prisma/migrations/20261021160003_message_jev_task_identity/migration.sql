CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_jev_subAgentId_idx"
ON "Message" ("agentId", "workflowGeneration", (metadata #> ARRAY['subAgentId']::text[]));
