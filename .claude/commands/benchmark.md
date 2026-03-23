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

**This is a loop. You MUST NOT stop or pause unless explicitly waiting for user approval. If diagnostics show issues, immediately proceed to the next step.**

## Setup

- Benchmarks run against **prod** (`https://navi-j9a9.onrender.com`) — no local services needed.
- Working directory: `cd agents` (all commands below assume this)
- Task argument: `$ARGUMENTS` (the benchmark task name, e.g. `build-boxing-payment`)

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

**What to watch for:**
- `INFINITE LOOP` — agent repeating the same message/tool call
- `STUCK` — tool IN_PROGRESS without FINISHED
- `TIME GAP` — 3+ minutes between messages (stalled LLM call)
- `HIGH TOOL COUNT` — one tool called 15+ times
- Tool errors (❌) in the tree
- Worker/backend/research log errors
- 120s with no new messages on any sub-agent = stall = actionable error

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

When you detect an error (from monitoring or benchmark completion):

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

## Step 7: PR and review loop

1. Create a branch and PR:
   ```bash
   git checkout -b fix/<descriptive-name>
   git add <files> && git commit -m "Fix: <description>"
   git push -u origin fix/<descriptive-name>
   gh pr create --title "Fix: <description>" --body "..."
   ```

2. **Wait for Claude Code Review** (poll every 30s, no timeout):
   ```bash
   gh pr checks <PR_NUMBER> --json name,state,conclusion
   ```

3. If `CHANGES_REQUESTED` → fix critical issues, push, re-poll. Skip menial/P3+ nits.

4. If `APPROVED` or no blocking issues → merge:
   ```bash
   gh pr merge <PR_NUMBER> --squash --delete-branch
   ```

## Step 8: Wait for deploy

Poll deployment actions (every 30s):

```bash
gh run list --workflow deploy-agents.yml --branch main --limit 1
gh run list --workflow deploy-research.yml --branch main --limit 1
```

Wait for all relevant deploys to show `completed success`. If any fail → new fix PR, review loop, merge, restart this step.

## Step 9: Rerun benchmark

Go back to **Step 1** (clean up old agents) and restart the full loop.

- If the benchmark now passes → **Step 10**
- If it fails with a new error → **Step 4** (diagnose again)
- If it fails with the same error → the fix didn't work, re-diagnose

## Step 10: Celebrate

On `COMPLETED`:
- Report final cost, elapsed time, number of fix iterations
- Show the result JSON path from `agents/benchmarks/runs/`

## CRITICAL RULES

1. **NEVER stop the loop** unless waiting for user approval.
2. **NEVER fire-and-forget** — monitor every 60s while the benchmark runs.
3. **120s stall = error** — if any sub-agent has no new messages for 120s, treat as actionable.
4. **Only 1 agent alive** — delete old agents before starting new ones.
5. **Never auto-approve** — approval requests from the agent always go to the user.
6. **Fix log pipeline first** — if logs are broken, fix that before debugging agent issues.
7. **All diagnostics in final message** — only the last message is visible to the user.
8. **`progress` is dead** — use message count, token count, and status instead.
