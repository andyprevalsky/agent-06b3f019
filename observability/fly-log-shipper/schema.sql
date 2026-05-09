CREATE DATABASE IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.fly_logs
(
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    timestamp String DEFAULT '',
    level LowCardinality(String) DEFAULT '',
    component LowCardinality(String) DEFAULT '',
    message String DEFAULT '',
    event String DEFAULT '',
    agent_id String DEFAULT '',
    workflow_id String DEFAULT '',
    span_id String DEFAULT '',
    parent_span_id String DEFAULT '',
    request_id String DEFAULT '',
    span_name LowCardinality(String) DEFAULT '',
    tool_name LowCardinality(String) DEFAULT '',
    toolName LowCardinality(String) DEFAULT '',
    tool_call_id String DEFAULT '',
    toolCallId String DEFAULT '',
    status String DEFAULT '',
    duration_ms Float64 DEFAULT 0,
    method LowCardinality(String) DEFAULT '',
    path String DEFAULT '',
    body String DEFAULT '',
    raw String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (agent_id, ingested_at, span_id)
TTL ingested_at + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;
