-- Tool-lifecycle writes look up one tool call's lifecycle rows (those with a
-- toolStatus) under its advisory lock. Without this index the lookup scanned
-- every message of the agent, and a multi-day code agent's transcript rows
-- under the same toolCallId made each write slower until it timed out.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_toolCallLifecycle_idx"
ON "Message" (
  "agentId",
  (metadata #> ARRAY['toolCallId']::text[]),
  (metadata #> ARRAY['toolStatus']::text[])
)
WHERE role = 'TOOL';
