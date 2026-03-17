# Agent Benchmark Harness

Spawns real agents against prod or localhost, polls for completion, evaluates pass/fail, handles approvals, retries transient failures, and stores results.

## Quick Start

```bash
cd agents

# List all benchmark tasks
python benchmarks/run_benchmark.py --list

# Run a single task against prod
python benchmarks/run_benchmark.py --task chat-mode

# Run all basic tasks against prod
python benchmarks/run_benchmark.py --suite basic

# Run all tasks against localhost
python benchmarks/run_benchmark.py --suite all --url http://localhost:3001

# Run without retry on failure
python benchmarks/run_benchmark.py --suite basic --no-retry

# Compare two runs
python benchmarks/run_benchmark.py --compare runs/A.json runs/B.json
```

## Suites (tags)

| Tag | Tasks | Description |
|-----|-------|-------------|
| `basic` | chat-mode, spawn-sub-agents, parallel-tool-calls, message-person | Core agent capabilities |
| `chat` | chat-mode | Chat mode only |
| `approval` | message-person | Tasks requiring approval handling |
| `browser` | browser-agent | Browser agent tasks |
| `claude-code` | claude-code-agent, files-in-sub-agents | Claude Code sandbox tasks |
| `attachment` | image-handling, files-in-sub-agents, agent-swarm | Tasks with file attachments |
| `swarm` | agent-swarm | Multi-agent swarm tasks |
| `all` | Everything | All 9 tasks |

## Tasks

| # | Name | Timeout | Cost Limit | Approval | Attachment |
|---|------|---------|------------|----------|------------|
| 1 | chat-mode | 120s | 25c | — | — |
| 2 | spawn-sub-agents | 300s | 100c | — | — |
| 3 | parallel-tool-calls | 180s | 50c | — | — |
| 4 | message-person | 180s | 50c | auto_approve | — |
| 5 | browser-agent | 600s | 200c | ignore | — |
| 6 | claude-code-agent | 300s | 100c | — | — |
| 7 | image-handling | 300s | 100c | — | rs.jpeg |
| 8 | files-in-sub-agents | 600s | 300c | — | rs.jpeg |
| 9 | agent-swarm | 600s | 500c | — | entities-12.csv |

## How It Works

1. **Auth**: Authenticates via Supabase OTP (test account)
2. **Create**: Creates agent via `POST /api/agents` with task-specific config
3. **Attachments**: Uploads test assets via `POST /api/agents/:id/attachments`
4. **Poll**: Every 5s checks agent status, handles approvals, detects stalls
5. **Evaluate**: On terminal status, checks pass criteria (status, tools used, approvals, progress score)
6. **Retry**: On failure, retries once. Pass on retry = transient failure
7. **Save**: Results stored as JSON in `agents/benchmarks/runs/`

## Result Format

```json
{
  "run_id": "uuid",
  "timestamp": "ISO",
  "suite": "basic",
  "base_url": "https://navi-j9a9.onrender.com",
  "summary": {
    "total": 4, "passed": 3, "failed": 1,
    "transient_failures": 1,
    "total_cost_cents": 42.5,
    "total_duration_seconds": 120,
    "pass_rate": 0.75
  },
  "tasks": [{ "name": "...", "passed": true, "agent_id": "...", ... }]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCHMARK_BASE_URL` | `https://navi-j9a9.onrender.com` | API base URL |
| `BACKEND_API_KEY` | **(required)** | API key for authentication |

## API Endpoint

`GET /api/benchmarks` — Returns all task definitions (no auth required).

## Prod Log Filtering

All agent logs are now filterable by `agent_id`:

**Backend (Render)**: Each HTTP log line includes `agent_id=<uuid>`
**Agent worker (Fly.io)**: JSON logs include `"agent_id": "<uuid>"` via structlog contextvars + `"temporal_workflow": {"workflow_id": "<uuid>"}` via Temporal
