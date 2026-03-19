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
| `approval` | message-person, family-office-angel-outreach | Tasks requiring approval handling |
| `browser` | browser-agent | Browser agent tasks |
| `claude-code` | claude-code-agent, files-in-sub-agents | Claude Code sandbox tasks |
| `attachment` | image-handling, files-in-sub-agents, agent-swarm | Tasks with file attachments |
| `swarm` | agent-swarm, family-office-angel-outreach | Multi-agent swarm tasks |
| `outreach` | family-office-angel-outreach | Personalized outreach at scale |
| `all` | Everything | All 10 tasks |

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
| 10 | family-office-angel-outreach | 600s | 1000c | prompt_user | vcs-and-angels.csv |

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
| `FLY_API_TOKEN` | — | Fly.io deploy token for worker log streaming (`agents/.env`) |
| `RENDER_API_KEY` | — | Render API key for backend log fetching (`back-end/.env`) |
| `SUPABASE_ACCESS_TOKEN` | — | Supabase management token for edge function logs (`agents/.env`) |

## API Endpoint

`GET /api/benchmarks` — Returns all task definitions (no auth required).

## Reviewing Benchmark Logs

Each benchmark run collects production logs from three sources and stores them in the result JSON under `tasks[].logs`. This is the primary way to debug failing benchmark agents.

### Log Sources

| Source | Key in JSON | What it captures | Filtered by |
|--------|-------------|------------------|-------------|
| **Render** (backend) | `backend_logs` | HTTP requests to/from the API (agent create, status updates, messages) | `agent_id` in URL/body |
| **Fly.io** (worker) | `worker_logs` | Agent execution logs (workflow start, LLM calls, tool execution, errors) | `agent_id` in structlog context |
| **Supabase** (research) | `research_logs` | Rose API gateway logs (completions calls, API key validation) | Time window (no agent_id in edge function logs) |
| **Messages** | `messages` | Full agent conversation transcript (USER/ASSISTANT/TOOL messages) | Always available |

### How to Read Logs from a Run

```bash
# Quick summary: how many logs per source
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for t in data['tasks']:
    logs = t.get('logs', {})
    print(f\"{t['name']}: backend={len(logs.get('backend_logs',[]))}, worker={len(logs.get('worker_logs',[]))}, research={len(logs.get('research_logs',[]))}, messages={len(logs.get('messages',[]))}\")"

# Detailed worker logs (most useful for debugging agent behavior)
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for entry in data['tasks'][0]['logs'].get('worker_logs', []):
    try:
        parsed = json.loads(entry)
        print(f\"[{parsed.get('level','')}] {parsed.get('event','')}\")
    except json.JSONDecodeError:
        print(entry)"

# Full message transcript
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for msg in data['tasks'][0]['logs'].get('messages', []):
    print(f\"[{msg['role']}] {msg['message'][:100]}\")"
```

### How Log Collection Works

- **Render**: REST API call to `api.render.com/v1/logs` with time window, filtered by agent_id
- **Fly.io**: `flyctl logs` streams as a background process for the entire benchmark run, capturing all worker output in real-time, then filtered by agent_id after each task completes
- **Supabase**: REST API call to `api.supabase.com/v1/projects/.../analytics/endpoints/logs.all` with time window, filtered for completions-related requests
- **Messages**: Extracted from the agent GET response (always available, no external API needed)

### Token Setup

```bash
# Fly.io (worker logs) — generate a deploy token
flyctl tokens create deploy -a navi-whisper-lux
# Add to agents/.env: FLY_API_TOKEN="<token>"

# Supabase (research logs) — generate at dashboard
# https://supabase.com/dashboard/account/tokens
# Add to agents/.env: SUPABASE_ACCESS_TOKEN="<token>"

# Render (backend logs) — already in back-end/.env: RENDER_API_KEY
```
