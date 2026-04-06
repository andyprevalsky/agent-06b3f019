# Rose Labs

AI agent platform with model racing infrastructure.
- Prod: https://roselabs.ai
- API: https://navi-j9a9.onrender.com
- Docs: https://docs.roselabs.ai

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
- `front-end/src/App.tsx` — React app
- `back-end/src/server.ts` — Express server
- `agents/worker.py` — Temporal worker
- `agents/workflows/agent_workflow.py` — Core agent logic
- `back-end/prisma/schema.prisma` — Database schema (source of truth)
- `research/supabase/functions/completions/index.ts` — Rose model racing endpoint
- `mac-app/main/index.ts` — Electron main process
- `docs/mint.json` — Mintlify docs config

Mac app releases: PRs with `mac-app/` changes need `MAC-APP-RELEASE` label. **Any `front-end/` changes also require a mac-app version bump** (new git tag push).

## External Context

| Resource | Access |
|----------|--------|
| Agent logs | `agents/navi-worker-log.txt` |
| Backend logs | `back-end/backend-logs.log` |
| Frontend logs | `front-end/frontend-logs.log` |
| Mac App logs | `mac-app/mac-app-console-logs.log` |
| Mac App IPC logs | `mac-app/mac-app-ipc-logs.log` |
| Research logs | `research/research-logs.log` |
| Docs logs | `docs/docs-logs.log` |
| Prod logs (Render/Fly/Supabase) | `docs/internal/prod-logs.md` |
| LLM call map (all call sites, context gates, token estimates) | `docs/internal/llm-call-map.md` |
| DB schema | `back-end/prisma/schema.prisma` |
| Realtime message types | `front-end/src/lib/realtime-types.ts` |
| Benchmark CLI & prod log review | `agents/benchmarks/README.md` |
| Plans (active) | `docs/plans/active/` |
| Plans (completed) | `docs/plans/completed/` |
| Query DB | `npx tsx back-end/scripts/query-db.ts` (modify as needed) |
| Backend debug scripts | `back-end/scripts/*.ts` |
| Agent test scripts | `agents/scripts/*.sh` |
| Rose API routes | `back-end/src/domains/agents/routes.ts` |
| API key auth | `back-end/src/providers/hybridAuth.ts` |
| Completions endpoint | `research/supabase/functions/completions/index.ts` |

## Guidelines

### Development
- **TDD loop** — don't return until tests pass: `while tests_failing: fix_errors(); run_tests()`
- **Test commands:** `cd back-end && npm run test:api` · `cd agents && python tests/run_all_tests.py` · `cd agents && python tests/e2e/run_e2e_tests.py --basic`
- **API changes require tests** — add to `back-end/src/tests/api-test-suite.ts`
- **Benchmarks** run against **prod** by default. CLI: `cd agents && python benchmarks/run_benchmark.py --list`. Read docstring before `--auto` mode.
- **Search before implementing** — find similar patterns in the codebase first (e.g., study existing tools before adding a new one)
- **No fallbacks during development** — they obscure whether the primary path actually works

### Architecture
- **Cross-cutting concerns flow through `providers/`** — domain code never uses raw `fetch`, `process.env`, retry loops, or npm clients directly
- **Zod schema changes require approval** — propose before implementing
- **Defensive fixes are a red flag** — fix root causes, not symptoms
- **Frontend state diagrams required** — comment at top of stateful components; keep updated when modifying state flow
- **Feature changes require diagrams** — show how the change fits into system context before writing code

### Temporal/Agent Patterns
- Workflows must be **deterministic** — no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** — safe on retry
- Error handling: catch → format → yield error event → **don't raise**
- See `agents/tools/base.py` for ToolManager pattern
- `agents/tools/spawn_agent.py` imports MUST be at module level (Temporal sandbox restriction — lazy imports trigger `threading.Lock` errors)

### Logging
- Always log: HTTP requests, external calls, workflow events, tool execution, DB mutations, errors
- Format: `[Component]` prefix, include IDs, truncate payloads to 200 chars

### Plans
- All plans live in `docs/plans/` — `active/` for in-progress, `completed/` for shipped. Filenames: kebab-case matching the task (e.g., `context-pointers.md`).
- **Before modifying a file**, check `docs/plans/completed/` for plans that touched it
- Plans must have **automated verification** — no manual steps. Ask for resources if needed.
- `/deploy` automatically moves plans from `active/` to `completed/`

### Database
- **ORM:** Prisma. **RLS:** enabled on all tables. Schema changes: edit `back-end/prisma/schema.prisma`, then migrate.
- **Realtime:** Supabase DB triggers auto-broadcast INSERT/UPDATE for `Message`/`Agent` tables — no manual broadcasting needed

### Rose API
- Docs: https://docs.roselabs.ai (localhost:3002 in dev)
- Completions: `research/supabase/functions/completions/index.ts` · Agents: `back-end/src/domains/agents/routes.ts` · Auth: `back-end/src/providers/hybridAuth.ts`

### Test Credentials (Dev)
- Supabase URL: `https://kzlurqihzaolhzsbkctf.supabase.co`
- Test phone: `+19729777432` · OTP: `181818`
- Backend API Key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
- Real user ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30` (Andy Prevalsky)

### Misc
- **No .md files** unless explicitly requested
- **Do NOT over-truncate** — truncate SPARINGLY, only for space-constrained UI
- **Short bash timeouts** (max 5 min) — check task output periodically
- **Pauses are user-initiated, not fixes** — never assume a pause caused a bug/crash
- **Sync Conductor workspace name on branch change:** `sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db "UPDATE workspaces SET pr_title = '$(git branch --show-current)' WHERE directory_name = '$(basename \"$PWD\")'"`
- If the next step is to check a log file, **call the tool yourself** — NEVER ask the user to check it
- Temporal workers don't hot-reload — must kill and restart after code changes. Old agents can't resume after code changes (nondeterminism error) — always create fresh.
- `run.sh` sets `TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME` (overrides `back-end/.env`)
