-- Read-only, aggregate-only. Parameters: exclusive end timestamp, account UUID.
-- Root conversations avoid counting generated child goals. Workflow-authored
-- rows and A2A are not human prompts. Do not deduplicate by text: repeated
-- instructions are real prompts. Only explicit request identities are folded.
WITH eligible AS (
  SELECT m.id, m."agentId", m.timestamp,
    COALESCE('attention:' || NULLIF(m.metadata->>'attentionRequestId', ''),
             'client:' || NULLIF(m.metadata->>'client_message_id', ''),
             'client:' || NULLIF(m.metadata->>'clientMessageId', ''),
             'request:' || NULLIF(m.metadata->>'idempotencyKey', ''), 'row:' || m.id) AS request_key
  FROM "Message" m JOIN "Agent" a ON a.id = m."agentId"
  WHERE a."userId" = $2 AND a."parentAgentId" IS NULL AND a.depth = 0
    AND NOT a."isBenchmark" AND a."worldModelMode" = 'real'
    AND m.role = 'USER' AND m.timestamp < $1::timestamptz
    AND m."workflowGeneration" IS NULL AND btrim(m.text) <> ''
    AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'a2a')
    AND COALESCE(m.metadata->>'isResponseSchemaUpdate', 'false') <> 'true'
    AND COALESCE(m.metadata->>'compactionSummary', 'false') <> 'true'
    AND COALESCE(m.metadata->>'excludeFromModel', 'false') <> 'true'
    AND COALESCE(m.metadata->>'isCodeTranscript', 'false') <> 'true'
), unique_prompts AS (
  SELECT DISTINCT ON ("agentId", request_key) timestamp
  FROM eligible ORDER BY "agentId", request_key, timestamp, id
), weekly AS (
  SELECT date_trunc('week', timestamp AT TIME ZONE 'America/Los_Angeles') AS week,
         count(*)::int AS count FROM unique_prompts GROUP BY 1
), bounds AS (
  SELECT min(week) AS first_week FROM weekly
), weeks AS (
  SELECT generate_series(first_week,
    date_trunc('week', ($1::timestamptz - interval '1 microsecond') AT TIME ZONE 'America/Los_Angeles'),
    interval '1 week') AS week FROM bounds
)
SELECT to_char(weeks.week, 'YYYY-MM-DD') AS "weekStart", COALESCE(weekly.count, 0)::int AS count,
       weeks.week + interval '1 week' > ($1::timestamptz AT TIME ZONE 'America/Los_Angeles') AS partial
FROM weeks LEFT JOIN weekly USING (week) ORDER BY weeks.week;
