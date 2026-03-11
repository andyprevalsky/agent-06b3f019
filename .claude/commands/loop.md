Autonomous agent testing loop. Follow this process EXACTLY when testing agent features (new tools, explore agent, spawn_agent, etc.).

## Prerequisites

- Real user ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30` (Andy Prevalsky, phone +19729777432)
- Backend API Key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
- Run script: `CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh`
- Worker log: `agents/navi-worker-log.txt`
- Backend log: `back-end/backend-logs.log`

## The Loop

### Step 1: Ensure services are running

If not already running, start the run script:
```bash
CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh 2>&1 &
```
Wait for `"Worker started, waiting for tasks..."` in `agents/navi-worker-log.txt` before proceeding.

### Step 2: Create an agent

```bash
curl -s -X POST "http://localhost:3001/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "<THE GOAL>", "start_phase": "plan"}'
```

- Use `"start_phase": "plan"` to bypass chat mode and go directly into plan -> execute.
- Use `"start_phase": "execute"` to skip planning too.
- Omit `start_phase` for normal chat mode.
- Save the returned `agent_id` for polling and cleanup.

### Step 3: Poll messages every 10 seconds

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
```

Messages are in `.messages[]`. Each message has `role`, `message`, and `metadata` (JSON with `toolName`, `toolStatus`, `title`, etc.).

Parse with python3 inline to see status, progress, and the last N messages with their tool names and statuses.

Watch for:
- Wrong tool being called (e.g., `spawn_agent type=code` when it should be `type=explore`)
- Error statuses
- Agent stuck (progress not advancing over multiple polls)
- Unexpected behavior (e.g., hallucinated data, wrong approach)

### Step 4: On test SUCCESS (agent completes normally)

**Still spin down! Don't leave services running.**

```
Step 4a: DELETE the agent (free resources)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"

Step 4b: KILL the run script (stop all services)
   pkill -f worker.py; pkill -f "npx tsx watch"; pkill -f "npx vite"; pkill -f electron
   lsof -ti :3001 | xargs kill -9  # force-free the port if needed

Step 4c: Report results to the user
```

### Step 5: On ANY unexpected behavior, IMMEDIATELY follow this strict sequence

**This is the most critical part. Do NOT skip steps or reorder them.**

```
Step 5a: DELETE the agent (stop bleeding tokens)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"

Step 5b: KILL the run script (stop all services)
   pkill -f worker.py; pkill -f "npx tsx watch"; pkill -f "npx vite"; pkill -f electron
   lsof -ti :3001 | xargs kill -9  # force-free the port if needed

Step 5c: READ logs and DIAGNOSE
   - Read agents/navi-worker-log.txt for tracebacks/errors
   - Query DB if needed to get raw message data
   - Identify the ROOT CAUSE before writing any code
   - DO NOT guess — find the actual error in the logs

Step 5d: FIX the root cause in code

Step 5e: RESTART the run script (resets log files, picks up code changes)
   CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh
   Wait for "Worker started, waiting for tasks..." in the log

Step 5f: Create a NEW agent and go back to step 3 (poll messages)
```

### CRITICAL RULES

1. **Do NOT continue polling a failed agent** — delete it FIRST. Every second it runs, it wastes tokens.
2. **Do NOT make fixes without killing the run script FIRST** — Temporal workers don't hot-reload. Your code changes won't take effect until you restart.
3. **Do NOT restart the run script without reading logs FIRST** — you'll just hit the same error again.
4. **Do NOT reuse old agents after code changes** — Temporal will throw nondeterminism errors. Always create fresh agents.
5. **Do NOT let agents run unsupervised** — poll every 10 seconds. If something looks wrong, delete immediately.

### Key Gotchas

- Temporal workers don't hot-reload — must kill and restart after code changes
- Old agents can't resume after code changes (Temporal nondeterminism error) — always create fresh
- The `run.sh` script sets `TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME` which overrides `back-end/.env`
- `spawn_agent.py` imports MUST be at module level (not lazy inside methods) because it runs inside Temporal's workflow sandbox. Lazy imports trigger `threading.Lock` errors.
- The `start_phase` parameter is not in the public API docs — it's a dev-only shortcut added for testing.

### Record of Fixes

Keep a running log of all fixes made during the testing session. For each fix, note:
- What failed (error message or symptom)
- Root cause
- What was changed (file + description)
- Whether the fix worked (verified in next test run)
