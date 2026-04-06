---
description: "Run a benchmark task in auto-debug mode. Spawns agent, monitors, diagnoses failures, fixes code, deploys, and reruns until COMPLETED."
argument-hint: "<task-name> [--prod] | list"
---

# Benchmark Auto-Debug Loop

Run a benchmark task, monitor it, and iteratively fix any issues until it passes.

## Parse arguments

Extract flags from `$ARGUMENTS`:
- If `$ARGUMENTS` contains `--prod`: set **MODE=prod**, remove `--prod` from the argument string to get the task name.
- Otherwise: set **MODE=local** (default).
- The remaining text after removing flags is the task name (e.g., `outreach-batch`).

Set variables based on mode:
- **Local mode** (`MODE=local`):
  - `BASE_URL=http://localhost:$CONDUCTOR_PORT`
  - Local services MUST be running
  - Local log files available: `agents/navi-worker-log.txt`, `back-end/backend-logs.log`, `research/research-logs.log`
- **Prod mode** (`MODE=prod`):
  - `BASE_URL=https://navi-j9a9.onrender.com`
  - Do NOT start or manage local services
  - Do NOT manage run.sh
  - Local log files are NOT available; use `agent_logs.py --prod` for all diagnostics

## If `$ARGUMENTS` is `list`

Run this and show the output to the user, then stop:
```bash
cd agents && python benchmarks/run_benchmark.py --list
```

## Otherwise: Auto-Debug Loop

**This is a loop. You MUST NOT stop or pause unless explicitly waiting for user approval or celebrating on COMPLETED (Step 10). If diagnostics show issues, immediately proceed to the next step.**

## Setup

- Working directory: `cd agents` (all commands below assume this)
- Task argument: the task name extracted from `$ARGUMENTS` (e.g. `build-boxing-payment`)
- API key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
- User ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30`
- Base URL: `$BASE_URL` (set during argument parsing above)

### If local mode (default)

1. **Pull latest main:** `git pull origin main`
2. **Ensure `run.sh` only starts back-end + agents + research** (no front-end, no mac-app). If front-end or mac-app service blocks are present in `scripts/run.sh`, remove them. Never remove back-end, agents, or research.
3. **Check if services are already running:**
   ```bash
   curl -s http://localhost:$CONDUCTOR_PORT/health | head -c 100
   ```
4. **If not running**, Conductor starts services via `bash scripts/run.sh` (see `conductor.json`). The `CONDUCTOR_PORT` and `CONDUCTOR_WORKSPACE_NAME` env vars are set by Conductor automatically.
   Wait for "Worker started, waiting for tasks..." in `agents/navi-worker-log.txt`.

### If prod mode

1. **Pull latest main:** `git pull origin main`
2. **Verify prod is reachable:**
   ```bash
   curl -s https://navi-j9a9.onrender.com/health | head -c 100
   ```
3. Do NOT start run.sh or local services. Do NOT modify run.sh.

## Step 1: Clean up old agents

Before starting, delete any existing agents for this task:

```bash
curl -s "$BASE_URL/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; [print(a['agent_id']) for a in json.load(sys.stdin)['agents']]"
```

Delete any that match the task goal. Only 1 agent per task should be alive at a time.

## Step 2: Run the benchmark

```bash
curl -s -X POST "$BASE_URL/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "<prompt from task>", "model": "rose-labs/rose-1-lite", "source": "MAC_APP", "price_limit_cents": <from task>, "start_phase": "<from task>"}'
```

Save the returned `agent_id`.

If the task has attachments, upload each one:
```bash
curl -s -X POST "$BASE_URL/api/agents/<agent_id>/attachments" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -F "file=@front-end/public/test-assets/<attachment_path>"
```

Then post the file pointers as a message using the `attachments` field (NOT `metadata`):
```bash
curl -s -X POST "$BASE_URL/api/agents/<agent_id>/messages" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"message": "[Files attached]", "attachments": [<file_pointer_objects_from_upload>]}'
```
The backend creates separate DB messages with `filePointer` field for each attachment. The agent's `extract_attachments_from_context()` reads `filePointer` from the top level of each message — NOT from metadata.

## Step 3: Monitor (blocking script)

**Do NOT poll manually.** Use the `benchmark_monitor.py` script — it polls every 60s, prints colored status lines, and exits when a stop condition is reached:

```bash
python benchmarks/benchmark_monitor.py <agent_id> --url $BASE_URL --interval 60
```

**Run this as a blocking bash call** (with a long timeout, e.g. 600000ms / 10min). The script handles all polling, stall detection, anomaly detection, and approval checking automatically. It prints a formatted status cell every 60s showing the full agent tree with per-agent idle times, costs, and anomalies.

**Exit codes:**
- `0` — COMPLETED → go to **Step 9** (celebrate)
- `1` — ACTION REQUIRED (error, stall, terminal failure) → go to **Step 4** (pause + diagnose)
- `2` — APPROVAL NEEDED → handle approval, then re-run the monitor

**On exit code 2 (approval needed):** The monitor output shows the approval request details. If the task's `approval_handling` is `auto_approve`, respond automatically:
```bash
curl -s -X POST "$BASE_URL/api/attention-requests/<request_id>/respond" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"response": "Approved"}'
```
If `prompt_user`, show the approval request to the user and wait for their response. **Never auto-approve when `prompt_user` is set.**
Then re-run the monitor script to continue watching.

**If the monitor script times out** (bash timeout), just re-run it — it's stateless and will pick up where it left off.

## Step 4: On error — Pause and diagnose

When diagnostics show `🔴 ACTION REQUIRED`, the message count stalls across polls, or the agent reaches a terminal status:

1. **Pause the root agent:**
   ```bash
   curl -s -X POST "$BASE_URL/api/agents/<agent_id>/pause" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Get full diagnostics:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --diagnostics --url $BASE_URL
   ```

3. **Drill into raw logs with grep** — raw log sources are noisy. ALWAYS pipe through grep to extract signal:

   **Worker logs** (Fly.io) — raw structlog JSON. Grep for errors:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source worker --url $BASE_URL 2>&1 | grep -i 'error\|failed\|traceback\|exception\|"level":"error"'
   ```
   If you need full context around a specific error, grep for a keyword from the error:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source worker --url $BASE_URL 2>&1 | grep -i '<keyword>'
   ```

   **Backend logs** (Render) — raw JSON HTTP logs, mostly 200s from poll requests. Filter out the noise:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source backend --url $BASE_URL 2>&1 | grep -v '"status":200' | grep -v '"status":204' | grep -v '"status":201'
   ```

   **Messages** — already well-formatted. Grep for errors or a specific tool:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source messages --url $BASE_URL 2>&1 | grep -i 'ERROR\|FAILED'
   ```
   Or to see only a specific tool's lifecycle:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source messages --url $BASE_URL 2>&1 | grep '<tool_name>'
   ```

   **Research logs** (Supabase) — gateway HTTP logs only (the Supabase Management API does NOT expose edge function console output via REST). Only useful for spotting 4xx/5xx responses:
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source research --url $BASE_URL 2>&1 | grep -v '| 200 \|| 201 \|| 202 '
   ```

   **IMPORTANT:** Do NOT dump an entire `--source` without grep. The raw output burns tokens for very little signal. Always grep first, then broaden the filter if the initial grep returns nothing.

4. **Check local log files (local mode only):**
   - `agents/navi-worker-log.txt` — worker tracebacks (grep for `ERROR\|Traceback\|Exception`)
   - `back-end/backend-logs.log` — backend HTTP errors (grep for `"level":"error"\|status":5`)
   - `research/research-logs.log` — research edge function console output including slog() calls (grep for `error\|failed\|429`)
   - **If prod mode:** Local log files are NOT available. Use the grep commands above for all log inspection. Note: edge function console.log output (the `slog()` calls in `completions/index.ts`) is NOT available via the Supabase Management API in prod. If you need to debug LLM racing, token auth, or model selection issues in prod, the evidence will be in worker logs (which log the response from the completions endpoint) rather than research logs.

5. **If the error involves LLM calls, 429s, or auth failures**, trace through the research layer:
   - Read `research/supabase/functions/completions/index.ts` — the Rose completions endpoint handling Claude token auth, rate limiting (429), and racing fallback
   - In local mode: grep `research/research-logs.log` for the `request_id` or `agent_id`
   - In prod mode: research console logs are NOT available via API. Instead, grep worker logs for the error response from the completions endpoint (the worker logs the HTTP status and error body it receives back)
   - Common issues: Claude OAuth token expired/rate-limited (429 from Anthropic), Supabase auth disabled (`phone_provider_disabled`), missing API keys in `.env` files
   - The benchmark harness loads `BACKEND_API_KEY` from `agents/.env` then `back-end/.env` — if both are missing, auth fails entirely

## Step 5: Propose fix to user

Present to the user in your LAST message (only the last message is visible):
- **Diagnosis:** What went wrong and why (with evidence from logs)
- **Root cause:** The specific code path that failed
- **Proposed fix:** What you plan to change
- **Ask for approval** before proceeding

## Step 6: Delete agent and apply fix

After user approves:

1. **Delete the root agent** (cascades to all descendants):
   ```bash
   curl -s -X DELETE "$BASE_URL/api/agents/<agent_id>" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Apply the approved code fix.**

3. **If local mode:** Restart local services if the fix touches backend/agents code (workers don't hot-reload). Conductor handles restart — just kill the run script and it restarts via `conductor.json`.
   **If prod mode:** Skip — the fix will be deployed in Step 7.

## Step 7: Deploy

Run `/deploy` to push the fix, create a PR, wait for review, merge, and wait for deploys to complete. The deploy skill handles the full PR → review → merge → deploy loop, and its local smoke step must use `bash scripts/run.sh --benchmark`.

## Step 8: Rerun benchmark

Go back to **Step 1** (clean up old agents) and restart the full loop.

- If the benchmark now passes → **Step 9**
- If it fails with a new error → **Step 4** (diagnose again)
- If it fails with the same error → the fix didn't work, re-diagnose

## Step 9: Celebrate

On `COMPLETED`:
- Report final cost, elapsed time, number of fix iterations
- Show the result JSON path from `agents/benchmarks/runs/`

## CRITICAL RULES

1. **NEVER stop the loop** unless waiting for user approval or celebrating (Step 9).
2. **NEVER fire-and-forget** — monitor every 60s while the benchmark runs.
3. **`🔴 ACTION REQUIRED` or stalled message count = immediate Step 4** — any verdict anomaly, tool error, log error, terminal status, or 120s message stall means pause immediately.
4. **Only 1 agent alive** — delete old agents before starting new ones.
5. **Never auto-approve** — approval requests from the agent always go to the user.
6. **Fix log pipeline first** — if logs are broken, fix that before debugging agent issues.
7. **All diagnostics in final message** — only the last message is visible to the user.
8. **`progress` is dead** — use message count, token count, and status instead.
9. **NEVER use broad process kills** — `pkill -f worker.py`, `pkill -f "npx tsx watch"`, `pkill -f "scripts/run.sh"`, or any other pattern-based kill will murder processes belonging to OTHER Conductor workspaces. Only kill by port (workspace-specific):
   ```bash
   # CORRECT — only kills THIS workspace's processes
   for port in $BACKEND_PORT $HEALTH_PORT $RESEARCH_PORT; do
       lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
   done
   ```
   ```bash
   # FORBIDDEN — kills ALL workspaces
   pkill -f worker.py
   pkill -f "npx tsx watch"
   pkill -f "scripts/run.sh"
   pkill -f "run_local_worker"
   ```
10. **Respect the mode** — use `$BASE_URL` for all API calls. In local mode, ensure local services are running. In prod mode, do NOT start or manage local services.
11. **Claude drives the loop** — do NOT delegate to `run_benchmark.py` for monitoring/approval/polling. You (Claude) execute each step directly using curl, `agent_logs.py`, and the task definition from `tasks.json`. Use `run_benchmark.py` only for `--list`.
12. **No front-end or mac-app** — benchmarks only need back-end + agents + research. In prod mode, no local services at all.
13. **Zero intervention after spawn** — once an agent is created with its attachments and file pointers posted, NEVER send additional user messages to help it (e.g., pasting CSV content, clarifying instructions). Benchmark tasks are designed to complete in one pass with only the initial prompt and attachments. If the agent can't read its attachments or gets stuck, that is a **real bug** — diagnose and fix the code, don't work around it by manually feeding data.
