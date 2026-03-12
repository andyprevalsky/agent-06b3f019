# Rose Labs

AI agent platform with model racing infrastructure.
- Production: https://roselabs.ai
- Backend API: https://navi-j9a9.onrender.com
- API Docs: https://docs.roselabs.ai

## Architecture

```
front-end/     → React/TypeScript/Vite (Vercel)
back-end/      → Express/TypeScript/Prisma (Render)
agents/        → Python Temporal workers (Fly.io)
research/      → Model development (rose-1-lite, rose-1-ultra)
mac-app/       → Electron desktop app (macOS only)
docs/          → API documentation (Mintlify)
```

**Key entry points:**
- `front-end/src/App.tsx` - React app
- `back-end/src/server.ts` - Express server
- `agents/worker.py` - Temporal worker
- `agents/workflows/agent_workflow.py` - Core agent logic
- `back-end/prisma/schema.prisma` - Database schema (source of truth)
- `research/supabase/functions/completions/index.ts` - Rose model racing endpoint
- `mac-app/main/index.ts` - Electron main process
- `docs/mint.json` - Mintlify docs config

**Mac app releases:** Push a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`) to trigger the release workflow which builds, signs, notarizes, and uploads to GitHub Releases. If a PR includes changes to `mac-app/`, create and push a new incremented tag when merging and notify the user that a new mac-app release will be created. Always keep `mac-app/package.json` version in sync with the latest git tag.

## Development

Run all services via Conductor (see `conductor.json`).

**Tests:**
```bash
cd back-end && npm run test:api         # Backend API tests
cd agents && python tests/run_all_tests.py  # Agent tool tests
cd agents && python tests/e2e/run_e2e_tests.py --basic  # E2E agent tests (spawns real agents via API)
```

## Log Files

Check these when errors occur:
- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`
- **Mac App (console):** `mac-app/mac-app-console-logs.log`
- **Mac App (IPC):** `mac-app/mac-app-ipc-logs.log`
- **Research (edge functions):** `research/research-logs.log`
- **Docs:** `docs/docs-logs.log`

## Critical Rules

1. **TDD loop** - Don't return until tests pass:
   ```
   while tests_failing:
       fix_errors()
       run_tests()
   ```

2. **API changes require tests** - Add to `back-end/src/tests/api-test-suite.ts`

3. **No .md files** - Never create markdown docs unless explicitly requested

4. **Zod schema changes require approval** - Propose changes before implementing

5. **Defensive fixes are a red flag** - Fix root causes, not symptoms

6. **Search before implementing** - When adding new features, first search the codebase for similar patterns (e.g., when adding a new tool, study existing tools)

7. **No fallbacks during development** - When testing a new integration, don't add fallback paths; they obscure whether the primary path actually works

8. **Frontend state diagrams required** - All frontend components must have a state machine diagram as a comment at the top of the file; reference and keep this diagram up to date when modifying state flow

9. **Feature changes require diagrams** - When implementing any feature, include a diagram showing how the change fits into the system context before writing code.

10. **Pauses are user-initiated, not fixes** - When debugging, NEVER assume a pause caused a bug/crash. The user sends a pause AFTER noticing something wrong. Pauses are the symptom reporter, not the cause.

11. **Short timeouts, check logs** - Never set bash timeouts longer than 5 minutes; use short timeouts and check task output periodically to ensure long-running tasks complete smoothly.

12. **Do NOT over-truncate** - Never aggressively truncate content, especially important context flows. Truncate SPARINGLY and only when necessary to fit content inside a frontend component (e.g., chip/bubble UI with limited space). When in doubt, keep the full content.

## Temporal/Agent Patterns

- Workflows must be **deterministic** - no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** - safe on retry
- Error handling: catch → format → yield error event → **don't raise**
- See `agents/tools/base.py` for ToolManager pattern

## Logging Guidelines

Always log these events (use `[Component]` prefix, include IDs, truncate payloads to 200 chars):
1. **HTTP requests** - method, path, body, response status, duration
2. **External calls** - Temporal, LLM, third-party APIs (request + response)
3. **Workflow events** - phase transitions, signals, completion/failure
4. **Tool execution** - tool name, input summary, output summary, duration
5. **DB mutations** - table, operation, record ID
6. **Errors** - message, stack, context (agentId, userId)

## Test Credentials (Dev)

- Supabase URL: `https://kzlurqihzaolhzsbkctf.supabase.co`
- Test phone: `+19729777432`
- Test OTP: `181818`
- Backend API Key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`

**Query backend locally:**
```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag="
```

## Database

- **ORM:** Prisma
- **RLS:** Enabled on all tables - users only see their own data
- **Realtime:** Supabase DB triggers automatically broadcast INSERT/UPDATE events for `Message` and `Agent` tables to the frontend via Supabase Realtime channels. Manual broadcasting is not needed for DB mutations.
- Schema changes: Edit `back-end/prisma/schema.prisma`, then migrate
- **Query DB:** `npx tsx back-end/scripts/query-db.ts` (modify script as needed)

## Supabase Realtime Messages

All realtime and tool message types are defined in `front-end/src/lib/realtime-types.ts`.

## Rose API

Public API for agents and completions. Docs: https://docs.roselabs.ai (localhost:3002 in dev)

- `docs/` - Mintlify API documentation
- `research/supabase/functions/completions/index.ts` - Completions endpoint (model racing)
- `back-end/src/routes/agents.ts` - Agents API (create, poll, pause/resume)
- `back-end/src/middleware/hybridAuth.ts` - API key authentication

**Test files:**
- `research/supabase/functions/completions/test-curl-example.txt` - curl example for rose-1-lite
- `research/supabase/functions/completions/test-browser-use-usage.mjs` - rose-1-browser-use test

## Production Logs (Render)

Fetch backend prod logs via Render API:
```bash
# Recent logs (last 50)
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=50&direction=backward" \
  | python3 -c "import sys,json; [print(l['message']) for l in json.load(sys.stdin)['logs']]"
```

Env vars are in `back-end/.env`:
- `RENDER_API_KEY` - Render API token
- `RENDER_SERVICE_ID` - `srv-d3jga77diees73cgrvk0`
- `RENDER_OWNER_ID` - `tea-csppgi56l47c73djvpig`

## Autonomous Agent Testing

When testing agent features (new tools, explore agent, spawn_agent, etc.), follow this loop:

**1. Look up the real user ID:**
```bash
cd back-end && npx tsx scripts/dump-sms-context.ts  # userId for phone +19729777432
```
Real user ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30` (Andy Prevalsky)

**2. Create an agent:**
```bash
curl -s -X POST "http://localhost:3001/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "...", "start_phase": "plan"}'
```
Use `"start_phase": "plan"` to bypass chat mode and go directly into the Temporal workflow (plan → execute).
Use `"start_phase": "execute"` to skip planning too. Omit `start_phase` for normal chat mode.

**3. Poll messages every 10 seconds via GET agent detail:**
```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
```
Messages are in the response under `.messages[]`. Each message has `role`, `message`, and `metadata` (JSON with `toolName`, `toolStatus`, `title`, etc.).

**4. On ANY unexpected behavior, IMMEDIATELY follow this strict sequence (no exceptions):**

```
Step 1: DELETE the agent (stop bleeding tokens)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"

Step 2: KILL the run script (stop all services)
   pkill -f worker.py; pkill -f "npx tsx watch"; pkill -f "npx vite"; pkill -f electron
   lsof -ti :3001 | xargs kill -9  # force-free the port if needed

Step 3: READ logs and DIAGNOSE
   - Read agents/navi-worker-log.txt for tracebacks/errors
   - Query DB if needed to get raw message data
   - Identify the ROOT CAUSE before writing any code

Step 4: FIX the root cause in code

Step 5: RESTART the run script (resets log files, picks up code changes)
   CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh
   Wait for "Worker started, waiting for tasks..." in the log

Step 6: Create a NEW agent and go back to step 3 (poll messages)
```

**CRITICAL: Do NOT skip steps or reorder them.** Especially:
- Do NOT continue polling a failed agent — delete it FIRST
- Do NOT make fixes without killing the run script FIRST (workers don't hot-reload)
- Do NOT restart the run script without reading logs FIRST (you'll just hit the same error)

**Key gotchas:**
- Temporal workers don't hot-reload — must kill and restart after code changes
- Old agents can't resume after code changes (Temporal nondeterminism error) — always create fresh
- The `run.sh` script sets `TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME` which overrides `back-end/.env`
- `spawn_agent.py` imports MUST be at module level (not lazy inside methods) because it runs inside Temporal's workflow sandbox. Lazy imports trigger `threading.Lock` errors.

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.
