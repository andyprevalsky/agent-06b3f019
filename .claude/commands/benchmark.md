---
description: "Run a benchmark task in auto-debug mode. Spawns agent against prod, monitors, diagnoses failures, fixes code, deploys, and reruns until COMPLETED."
argument-hint: "<task-name> | list"
---

# Benchmark Auto-Debug Loop

Run a benchmark task against prod, monitor it, and iteratively fix any issues until it passes.

## If `$ARGUMENTS` is `list`

Run this and show the output to the user, then stop:
```bash
cd agents && python benchmarks/run_benchmark.py --list
```

## Otherwise: Auto-Debug Loop

**This is a loop. You MUST NOT stop or pause unless explicitly waiting for user approval or celebrating on COMPLETED (Step 10). If diagnostics show issues, immediately proceed to the next step.**

## Setup

- Benchmarks run against **prod** (`https://navi-j9a9.onrender.com`) — no local services needed.
- Working directory: `cd agents` (all commands below assume this)
- Task argument: `$ARGUMENTS` (the benchmark task name, e.g. `build-boxing-payment`)
- If you need a local smoke reproduction before or after the prod run, start services with `bash scripts/run.sh --benchmark`. That mode skips `front-end` and `mac-app`; benchmark/smoke runs should never boot either UI service.

## Step 1: Clean up old agents

Before starting, delete any existing agents for this task:

```bash
curl -s "https://navi-j9a9.onrender.com/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; [print(a['agent_id']) for a in json.load(sys.stdin)['agents']]"
```

Delete any that match the task goal. Only 1 agent per task should be alive at a time.

## Step 2: Run the benchmark

```bash
cd agents && python benchmarks/run_benchmark.py --task $ARGUMENTS
```

Run this in the background. Save the task ID for monitoring.

## Step 3: Monitor every 60 seconds

**You MUST poll every 60 seconds. Never fire-and-forget.**

First, find the agent ID from the benchmark output or by listing agents (Step 1 command).

Then use the diagnostics tool:

```bash
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
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
curl -s "https://navi-j9a9.onrender.com/api/agents/tree?busId=<agent_id>" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{a[\"agent_id\"][:12]} cost={a.get(\"tree_cost_cents\",0)}c msgs={a.get(\"message_count\",0)} [{a[\"status\"]}]') for a in d['agents']]"
```

Report cost & elapsed time to the user regularly.

## Step 4: On error — Pause and diagnose

When diagnostics show `🔴 ACTION REQUIRED`, the message count stalls across polls, or the agent reaches a terminal status:

1. **Pause the root agent:**
   ```bash
   curl -s -X POST "https://navi-j9a9.onrender.com/api/agents/<agent_id>/pause" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Get full diagnostics:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
   ```

3. **Get detailed logs per source if needed:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source worker    # Fly.io worker logs
   python benchmarks/agent_logs.py <agent_id> --tree --source backend   # Render HTTP logs
   python benchmarks/agent_logs.py <agent_id> --tree --source messages  # Full message transcripts
   python benchmarks/agent_logs.py <agent_id> --tree --source research  # Supabase edge function logs
   ```

4. **Identify root cause** — read the relevant agent code, don't guess.

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
   curl -s -X DELETE "https://navi-j9a9.onrender.com/api/agents/<agent_id>" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Apply the approved code fix.**

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
