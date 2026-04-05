---
description: "Run a benchmark task in auto-debug mode. Spawns agent locally, monitors, diagnoses failures, fixes code, deploys, and reruns until COMPLETED."
argument-hint: "<task-name> | list"
---

# Benchmark Auto-Debug Loop

Run a benchmark task against **localhost**, monitor it, and iteratively fix any issues until it passes.

## If `$ARGUMENTS` is `list`

Run this and show the output to the user, then stop:
```bash
cd agents && python benchmarks/run_benchmark.py --list
```

## Otherwise: Auto-Debug Loop

**This is a loop. You MUST NOT stop or pause unless explicitly waiting for user approval or celebrating on COMPLETED (Step 9). If diagnostics show issues, immediately proceed to the next step.**

## Setup

- Benchmarks run against **localhost** — local services MUST be running.
- Working directory: `cd agents` (all commands below assume this)
- Task argument: `$ARGUMENTS` (the benchmark task name, e.g. `build-boxing-payment`)
- API key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
- User ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30`
- Base URL: `http://localhost:$CONDUCTOR_PORT` (port comes from the Conductor environment)

### Ensure local services are running

1. **Pull latest main:** `git pull origin main`
2. **Ensure `run.sh` only starts back-end + agents + research** (no front-end, no mac-app). If front-end or mac-app service blocks are present in `scripts/run.sh`, remove them. Never remove back-end, agents, or research.
3. **Check if services are already running:**
   ```bash
   curl -s http://localhost:$CONDUCTOR_PORT/health | head -c 100
   ```
4. **If not running**, Conductor starts services via `bash scripts/run.sh` (see `conductor.json`). The `CONDUCTOR_PORT` and `CONDUCTOR_WORKSPACE_NAME` env vars are set by Conductor automatically.
   Wait for "Worker started, waiting for tasks..." in `agents/navi-worker-log.txt`.

## Step 1: Clean up old agents

Before starting, delete any existing agents for this task:

```bash
curl -s "http://localhost:$CONDUCTOR_PORT/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; [print(a['agent_id']) for a in json.load(sys.stdin)['agents']]"
```

Delete any that match the task goal. Only 1 agent per task should be alive at a time.

## Step 2: Create the agent

Read the task definition from `agents/benchmarks/tasks.json` to get the prompt, attachments, model, start_phase, price_limit_cents, and eval_prompt.

```bash
curl -s -X POST "http://localhost:$CONDUCTOR_PORT/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "<prompt from task>", "model": "rose-labs/rose-1-lite", "source": "MAC_APP", "price_limit_cents": <from task>, "start_phase": "<from task>"}'
```

Save the returned `agent_id`.

If the task has attachments, upload each one:
```bash
curl -s -X POST "http://localhost:$CONDUCTOR_PORT/api/agents/<agent_id>/attachments" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -F "file=@front-end/public/test-assets/<attachment_path>"
```

Then post the file pointers as a message so the agent can see them.

## Step 3: Monitor every 60 seconds

**You MUST poll every 60 seconds. Never fire-and-forget.**

Use the diagnostics tool:

```bash
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
```

This shows: agent tree status, message counts, tool distribution, errors, anomalies (infinite loops, stalls, stuck tools, time gaps). The output ends with a verdict line:
- `🟢 HEALTHY` — no issues detected, continue monitoring
- `🔴 ACTION REQUIRED — <reasons>` — issues detected

**Decision rule after each poll:**
- If the verdict is `🔴 ACTION REQUIRED` → **IMMEDIATELY go to Step 4** (pause + diagnose). No exceptions. Do not "wait another cycle." Do not rationalize.
- If the verdict is `🟢 HEALTHY` → continue monitoring (next poll in 60s)

The verdict aggregates these signals across the entire agent tree:
- `❌` tool errors (toolStatus == ERROR)
- `STUCK` — tool IN_PROGRESS without FINISHED
- `TIME GAP` — 3+ minutes between messages (stalled LLM call)
- `INFINITE LOOP` — same message repeated 4+ times
- `HIGH TOOL COUNT` — one tool called 15+ times
- Terminal agent status (FAILED, COST_LIMIT_REACHED, OUT_OF_CREDITS)

**What NOT to use for monitoring:**
- `progress` field — dead variable, ignore it
- Raw API polling — use `agent_logs.py` instead

**Cost tracking:**
```bash
curl -s "http://localhost:$CONDUCTOR_PORT/api/agents/tree?busId=<agent_id>" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{a[\"agent_id\"][:12]} cost={a.get(\"tree_cost_cents\",0)}c msgs={a.get(\"message_count\",0)} [{a[\"status\"]}]') for a in d['agents']]"
```

Report cost & elapsed time to the user regularly.

**Approval handling:**
Check for pending approval requests and surface them to the user:
```bash
curl -s "http://localhost:$CONDUCTOR_PORT/api/attention-requests" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  | python3 -c "import json,sys; reqs=json.load(sys.stdin).get('requests',[]); [print(f'id={r[\"id\"]} agent={r[\"agent_id\"][:12]} q={r[\"question\"][:150]}') for r in reqs if not r.get('answered')]"
```

If the task's `approval_handling` is `auto_approve`, respond automatically:
```bash
curl -s -X POST "http://localhost:$CONDUCTOR_PORT/api/attention-requests/<request_id>/respond" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"response": "Approved"}'
```

If `prompt_user`, show the approval request to the user and wait for their response. **Never auto-approve when `prompt_user` is set.**

## Step 4: On error — Pause and diagnose

When diagnostics show `🔴 ACTION REQUIRED` (or agent reaches a terminal status):

1. **Pause the root agent:**
   ```bash
   curl -s -X POST "http://localhost:$CONDUCTOR_PORT/api/agents/<agent_id>/pause" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Get full diagnostics:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
   ```

3. **Get detailed logs per source if needed:**
   ```bash
   python benchmarks/agent_logs.py <agent_id> --tree --source worker    # Worker logs
   python benchmarks/agent_logs.py <agent_id> --tree --source backend   # Backend HTTP logs
   python benchmarks/agent_logs.py <agent_id> --tree --source messages  # Full message transcripts
   python benchmarks/agent_logs.py <agent_id> --tree --source research  # Research edge function logs
   ```

4. **Check local log files** — since we run locally:
   - `agents/navi-worker-log.txt` — worker tracebacks
   - `back-end/backend-logs.log` — backend HTTP errors
   - `research/research-logs.log` — research edge function errors

5. **Identify root cause** — read the relevant agent code, don't guess.

6. **If the error involves LLM calls, 429s, or auth failures**, trace through the research layer:
   - Read `research/supabase/functions/completions/index.ts` — this is the Rose completions endpoint that handles Claude token auth, rate limiting (429 → `CLAUDE_RATE_LIMITED`), and racing fallback
   - Check `--source research` logs for Supabase edge function errors
   - Common issues: Claude OAuth token expired/rate-limited (429 from Anthropic → research returns `CLAUDE_RATE_LIMITED` with `fallback: 'racing'`), Supabase auth disabled (`phone_provider_disabled`), missing API keys in `.env` files

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
   curl -s -X DELETE "http://localhost:$CONDUCTOR_PORT/api/agents/<agent_id>" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
   ```

2. **Apply the approved code fix.**

3. **Restart local services** if the fix touches backend/agents code (workers don't hot-reload). Conductor handles restart — just kill the run script and it restarts via `conductor.json`.

## Step 7: Deploy

Run `/deploy` to push the fix, create a PR, wait for review, merge, and wait for deploys to complete. The deploy skill handles the full PR → review → merge → deploy loop.

## Step 8: Rerun benchmark

Go back to **Step 1** (clean up old agents) and restart the full loop.

- If the benchmark now passes → **Step 9**
- If it fails with a new error → **Step 4** (diagnose again)
- If it fails with the same error → the fix didn't work, re-diagnose

## Step 9: Celebrate

On `COMPLETED`:
- Report final cost, elapsed time, number of fix iterations
- Delete the benchmark agent (clean up)

## CRITICAL RULES

1. **NEVER stop the loop** unless waiting for user approval or celebrating (Step 9).
2. **NEVER fire-and-forget** — monitor every 60s while the benchmark runs.
3. **`🔴 ACTION REQUIRED` = immediate Step 4** — any anomaly (STUCK, TIME GAP, INFINITE LOOP, HIGH TOOL COUNT) or tool error in the verdict means pause immediately.
4. **Only 1 agent alive** — delete old agents before starting new ones.
5. **Never auto-approve** — approval requests from the agent always go to the user (unless task says `auto_approve`).
6. **Fix log pipeline first** — if logs are broken, fix that before debugging agent issues.
7. **All diagnostics in final message** — only the last message is visible to the user.
8. **`progress` is dead** — use message count, token count, and status instead.
9. **Run locally** — always use `http://localhost:$CONDUCTOR_PORT`, never prod URLs. Ensure services are running before starting.
10. **Claude drives the loop** — do NOT delegate to `run_benchmark.py` for monitoring/approval/polling. You (Claude) execute each step directly using curl, `agent_logs.py`, and the task definition from `tasks.json`. Use `run_benchmark.py` only for `--list`.
11. **No front-end or mac-app** — benchmarks only need back-end + agents + research. Remove front-end and mac-app service blocks from `run.sh` before starting.
