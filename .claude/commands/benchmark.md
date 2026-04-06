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

Then post the file pointers as a message so the agent can see them.

## Step 3: Monitor every 60 seconds

**You MUST poll every 60 seconds. Never fire-and-forget.**

Use the diagnostics tool:

```bash
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics --url $BASE_URL
```

This shows: agent tree status, message counts, tool distribution, errors, anomalies (infinite loops, stalls, stuck tools, time gaps).

The output ends with a verdict line:
- `🟢 HEALTHY` — no issues detected, continue monitoring
- `🔴 ACTION REQUIRED — <reasons>` — issues detected

**Decision rule after each poll:**
- If the verdict is `🔴 ACTION REQUIRED` → **IMMEDIATELY go to Step 4** (pause + diagnose). No exceptions. Do not "wait another cycle." Do not rationalize.
- If the total message count is unchanged from the previous poll after 60s → **IMMEDIATELY go to Step 4**. Treat this as a stall even if the verdict is `🟢 HEALTHY`.
- Otherwise → continue monitoring (next poll in 60s)

The verdict aggregates these signals across the entire agent tree:
- `❌` tool errors (toolStatus == ERROR)
- `STUCK` — tool IN_PROGRESS without FINISHED
- `TIME GAP` — 3+ minutes between messages (stalled LLM call)
- `INFINITE LOOP` — same message repeated 4+ times
- `HIGH TOOL COUNT` — one tool called 15+ times
- Worker/backend/research log errors
- Terminal agent status (FAILED, COST_LIMIT_REACHED, OUT_OF_CREDITS)

**What NOT to use for monitoring:**
- `progress` field — dead variable, ignore it
- Raw API polling — use `agent_logs.py` instead

**Cost tracking:**
```bash
curl -s "$BASE_URL/api/agents/tree?busId=<agent_id>" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{a[\"agent_id\"][:12]} cost={a.get(\"tree_cost_cents\",0)}c msgs={a.get(\"message_count\",0)} [{a[\"status\"]}]') for a in d['agents']]"
```

Report cost & elapsed time to the user regularly.

**Approval handling:**
Check for pending approval requests and surface them to the user:
```bash
curl -s "$BASE_URL/api/attention-requests" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; reqs=json.load(sys.stdin).get('requests',[]); [print(f'id={r[\"id\"]} agent={r[\"agent_id\"][:12]} q={r[\"question\"][:150]}') for r in reqs if not r.get('answered')]"
```

If the task's `approval_handling` is `auto_approve`, respond automatically:
```bash
curl -s -X POST "$BASE_URL/api/attention-requests/<request_id>/respond" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"response": "Approved"}'
```

If `prompt_user`, show the approval request to the user and wait for their response. **Never auto-approve when `prompt_user` is set.**

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

3. **Get detailed logs per source if needed:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source worker --url $BASE_URL
   python benchmarks/agent_logs.py <agent_id> --tree --source backend --url $BASE_URL
   python benchmarks/agent_logs.py <agent_id> --tree --source messages --url $BASE_URL
   python benchmarks/agent_logs.py <agent_id> --tree --source research --url $BASE_URL
   ```

4. **Check log files:**
   - **If local mode:** Check local log files:
     - `agents/navi-worker-log.txt` — worker tracebacks
     - `back-end/backend-logs.log` — backend HTTP errors
     - `research/research-logs.log` — research edge function errors
   - **If prod mode:** Local log files are NOT available. Use the `--source` commands above for all log inspection.

5. **If the error involves LLM calls, 429s, or auth failures**, trace through the research layer:
   - Read `research/supabase/functions/completions/index.ts` — this is the Rose completions endpoint that handles Claude token auth, rate limiting (429 → `CLAUDE_RATE_LIMITED`), and racing fallback
   - Check `--source research` logs for Supabase edge function errors
   - Common issues: Claude OAuth token expired/rate-limited (429 from Anthropic → research returns `CLAUDE_RATE_LIMITED` with `fallback: 'racing'`), Supabase auth disabled (`phone_provider_disabled`), missing API keys in `.env` files
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
