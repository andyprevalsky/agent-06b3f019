CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_jev_task_id_idx"
ON "Message" ("agentId", "workflowGeneration", (metadata #> ARRAY['task_id']::text[]));
