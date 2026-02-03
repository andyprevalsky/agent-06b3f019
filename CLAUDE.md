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

**Mac app releases:** Push a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`) to trigger the release workflow which builds, signs, notarizes, and uploads to GitHub Releases.

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

9. **Code changes require `**` in latest message** - Do NOT edit/write/delete files unless the user's most recent message contains `**`. Authorization expires after each response—if the next message lacks `**`, no file modifications allowed. Git operations (commits, PRs, pushes) and DB writes, .env reads, exploration are always allowed.

10. **Feature changes require diagrams** - When implementing any feature, include a diagram showing how the change fits into the system context before writing code.

11. **Pauses are user-initiated, not fixes** - When debugging, NEVER assume a pause caused a bug/crash. The user sends a pause AFTER noticing something wrong. Pauses are the symptom reporter, not the cause.

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

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.
