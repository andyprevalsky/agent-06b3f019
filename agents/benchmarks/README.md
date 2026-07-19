# Agent Benchmark Harness

Spawns real agents against prod or localhost, polls for completion, evaluates pass/fail, handles approvals, retries transient failures, and stores results.

## Eval Suite (the ONE catalog)

`tasks.json` is the single canonical benchmark catalog (see CLAUDE.md "Eval Suite"). Each entry carries the additive eval contract — `status` (`ready` | `incomplete`), `runner` (`agent`), `bench` (`pipeline-e2e` harness plumbing | `rose-bench` harness-independent capability), `description`, `environment`, `evaluators[]`, `source` — validated by `long_horizon.py:validate_catalog()`. Idea kernels live in `long_horizon_ideas.json`.

```bash
# THE full-suite entrypoint: every ready benchmark eval
python benchmarks/run_eval_suite.py --port 3001

# Print the holding set (ready vs incomplete)
python benchmarks/run_eval_suite.py --list

# Run a named subset
python benchmarks/run_eval_suite.py --only test-mass-agent-run-0,browser-agent

# Run one bench axis
python benchmarks/run_eval_suite.py --bench rose-bench --port 3001
```

Every task runs on a **base-image fixture**: undeclared environments inherit `base:victoria-prod-sync-v1` (workspace prod-sync DB, `scripts/setup-db.sh`) at load time — registry + pg_dump freezer in `fixtures.py`. Every completed run — pass or fail — is recorded: full record in `runs/*.json`, one line per attempt in `history/task_attempts.jsonl` (`record_attempt`), full LLM trajectories in `.llm-dumps/<agent_id>/` (always-on locally).

### Live data fixtures (`environment.live_fixtures`)

`db_fixtures` are *frozen* task deltas on a base image (reproducible). The single **`live` fixture** is the opposite: an explicit prod-synced overlay for credentials that must be current at runtime. It includes compute tokens, browser context/provider profiles, cookies and origin storage, passwords, passkeys, `CookieBundle` rows, and `SteelSessionAuth` rows. A frozen expired token is worthless, so tasks that need current credentials declare the overlay explicitly.

Declare it only on tasks that exercise current credentials:

```jsonc
"environment": {
  "mode": "live",
  "live_fixtures": ["live"]
}
```

- **`live`** — syncs fresh compute tokens plus the complete browser-auth graph from production (`seed-local.ts --compute-tokens-only` and `--credentials-only`). In simulator mode the overlay is skipped as a unit because environment-boundary tools are simulated.
- Omitted `live_fixtures` resolve to `[]`; using a live website does not implicitly import production credentials.
- Site-specific setup is task scenario logic, not another live fixture. For example, the Amazon passkey probe applies `live`, then temporarily removes competing cookie/password paths and restores them in cleanup.

Validated by `long_horizon.py:_validate_environment`: the only accepted fixture name is `live`, and synthetic tasks cannot declare it.

Task-specific DB deltas remain separate from the base image. The dedicated gate-user deltas are safe to pre-seed physically, but their declarations remain useful for reset/isolation. Plaid and user-data deltas use the regular benchmark user and must not be bundled into the shared base image because they would contaminate unrelated tasks.

Suite selection (`run_benchmark.py --suite ...`) runs only `status: "ready"` benchmark entries; explicit `--task <name>` still targets incomplete agent evals for dev iteration. **Never rename an existing task `name`** — it is the primary key into `history/task_durations.jsonl` (success ledger), `history/span_durations.jsonl` (p99 baselines), and `runs/*.json`; a rename orphans that history (guarded by `test_history_ledger_task_names_still_exist_in_catalog`). The FE dev query box reads this same catalog via `GET /api/benchmarks/test-prompts`.

## Quick Start

```bash
cd agents

# List all benchmark tasks
python benchmarks/run_benchmark.py --list

# Run a single task against prod
python benchmarks/run_benchmark.py --task chat-mode

# Run all smoke tasks against prod
python benchmarks/run_benchmark.py --suite smoke

# Run all tasks against localhost
python benchmarks/run_benchmark.py --suite all --url http://localhost:3001

# Run without retry on failure
python benchmarks/run_benchmark.py --suite smoke --no-retry

# Run a benchmark until root message index 42, export a source, and create a paused checkpoint
../scripts/run-bench chat-mode --checkpoint 42 --checkpoint-no-start

# Resume that paused checkpoint later
../scripts/run-bench chat-mode \
  --checkpoint-start-agent-id <agent-id> \
  --checkpoint-manifest .context/benchmarks/<run-id>/checkpoints/chat-mode.json

# Compare two runs
python benchmarks/run_benchmark.py --compare runs/A.json runs/B.json
```

`scripts/run-bench <task> --checkpoint <turn_n>` uses the normal local benchmark
orchestrator: it starts an isolated stack, runs the selected benchmark with its
usual fixtures/attachments until the root transcript contains that message index,
pauses the source agent, exports root/tree checkpoint JSON, clones that exported
state, starts the workflow at `execute_dag_resume`, polls the normal benchmark
evaluator, and validates post-checkpoint reasoning-row hygiene.
For `test-mass-agent-run-0`, the runner also enforces the expected post-fanout
visible-card sequence. Use `--checkpoint-no-start` to leave a paused workflow
open in the local FE; the runner keeps that isolated stack alive and prints the
resume command. To reuse a pre-existing export instead of generating one, pass
`--checkpoint-source-json`; optional tree cloning uses `--checkpoint-tree-json`.

## Suites (tags)

The curated tag vocabulary (each task carries zero or more):

| Tag | Description |
|-----|-------------|
| `antibot` | Bot-challenge / biometric-defeat browser tasks |
| `attachments` | Tasks with file attachments or document handling |
| `auth` | Tasks needing authenticated sessions (cookie, minted, or anon accounts) |
| `browser` | Browser agent tasks |
| `cache` | Fast-mode cache record/replay tasks |
| `chat` | Chat mode only |
| `code-agent` | Claude Code sandbox tasks |
| `grep` | User-data grep/search tasks |
| `load-test` | Mass-agent / scale load tests |
| `outreach` | Personalized outreach at scale |
| `payment` | Payment and checkout flows |
| `phone` | Phone-call tasks |
| `plaid` | Plaid-connected finance tasks |
| `research` | Deep-research tasks |
| `smoke` | Deploy-gate smoke suite |
| `social` | Social-account tasks |
| `sub-agent-fan-out` | Multi-agent for-each fan-out tasks |
| `transactions` | Transaction analysis tasks |
| `voice` | Voice tasks |
| `wait-for` | wait_for scheduling tasks |

Special suite selectors (not tags): `all` (every ready agent task), `auth`
(cookie-auth task by default, anon tasks with `--anon` — split by task name),
`rose-bench` / `pipeline-e2e` (bench axis).

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
| 9 | agent-for-each | 600s | 500c | — | entities-12.csv |
| 10 | build-boxing-payment | 900s | 1000c | prompt_user | waivers PDFs |
| 11 | job-applications | 900s | 1000c | prompt_user | 2x resume PDFs |

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
| `CLICKHOUSE_ENDPOINT` | — | ClickHouse Cloud endpoint for retained Fly.io worker logs (`agents/.env`) |
| `CLICKHOUSE_USER` | — | ClickHouse user for retained Fly.io worker logs (`agents/.env`) |
| `CLICKHOUSE_PASSWORD` | — | ClickHouse password for retained Fly.io worker logs (`agents/.env`) |
| `FLY_API_TOKEN` | — | Fly.io deploy token for worker log streaming (`agents/.env`) |
| `RENDER_API_KEY` | — | Render API key for backend log fetching (`back-end/.env`) |
| `SUPABASE_ACCESS_TOKEN` | — | Supabase management token for edge function logs (`agents/.env`) |

## API Endpoint

`GET /api/benchmarks` — Returns all task definitions (no auth required).

## Reviewing Benchmark Logs

Each benchmark run collects production logs from retained ClickHouse rows and live production sources, then stores them in the result JSON under `tasks[].logs`. This is the primary way to debug failing benchmark agents.

### Log Sources

| Source | Key in JSON | What it captures | Filtered by |
|--------|-------------|------------------|-------------|
| **Render** (backend) | `backend_logs` | HTTP requests to/from the API (agent create, status updates, messages) | `agent_id` in URL/body |
| **ClickHouse** (retained Fly.io worker) | `worker_logs` | Agent execution logs retained for 7 days | `agent_id` in structlog context or raw JSON |
| **Fly.io** (live worker stream) | `worker_logs` | Live agent execution logs during benchmark runs | `agent_id` in structlog context |
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

### Query Retained Worker Logs Directly

```bash
cd agents && source .env

# Logs for one agent
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"

# Recent worker errors
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, level, event, message, raw FROM observability.fly_logs WHERE parseDateTimeBestEffortOrNull(timestamp) > now() - INTERVAL 1 HOUR AND (level IN ('error','exception') OR raw ILIKE '%error%' OR raw ILIKE '%traceback%') ORDER BY ingested_at DESC LIMIT 100 FORMAT JSONEachRow"
```

### How Log Collection Works

- **Render**: REST API call to `api.render.com/v1/logs` with time window, filtered by agent_id
- **ClickHouse**: retained Fly.io worker logs are queried from `observability.fly_logs`, filtered by agent_id, and merged into `worker_logs`
- **Fly.io**: `flyctl logs` streams as a background process for the entire benchmark run, capturing live worker output, then filtered by agent_id after each task completes
- **Supabase**: REST API call to `api.supabase.com/v1/projects/.../analytics/endpoints/logs.all` with time window, filtered for completions-related requests
- **Messages**: Extracted from the agent GET response (always available, no external API needed)

### Token Setup

```bash
# Fly.io (worker logs) — generate a deploy token
flyctl tokens create deploy -a navi-whisper-lux
# Add to agents/.env: FLY_API_TOKEN="<token>"

# ClickHouse (retained worker logs) — values come from ClickHouse Cloud
# Add to agents/.env: CLICKHOUSE_ENDPOINT, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD

# Supabase (research logs) — generate at dashboard
# https://supabase.com/dashboard/account/tokens
# Add to agents/.env: SUPABASE_ACCESS_TOKEN="<token>"

# Render (backend logs) — already in back-end/.env: RENDER_API_KEY
```
