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

**Mac app releases:** PRs that include `mac-app/` changes should be labeled `MAC-APP-RELEASE`. When a PR with this label is merged, CI automatically bumps the patch version, creates a git tag, and pushes it — which triggers the full release workflow (build, sign, notarize, upload). No manual tagging needed. You can also trigger a release manually by pushing a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`).

## Development

Run all services via Conductor (see `conductor.json`).

**Tests:**
```bash
cd back-end && npm run test:api         # Backend API tests
cd agents && python tests/run_all_tests.py  # Agent tool tests
cd agents && python tests/e2e/run_e2e_tests.py --basic  # E2E agent tests (spawns real agents via API)
```

**Benchmarks:** See `agents/benchmarks/README.md` for the full CLI reference and **prod log review instructions** (how to read Render/Fly.io/Supabase logs from benchmark runs). Quick: `cd agents && python benchmarks/run_benchmark.py --list`. **IMPORTANT:** Benchmarks run against **prod** by default — no local services needed. Before running `--auto` mode, read the docstring at the top of `agents/benchmarks/run_benchmark.py` to understand the full auto-debug-fix-deploy loop.

## Log Files

Check these when errors occur:
- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`
- **Mac App (console):** `mac-app/mac-app-console-logs.log`
- **Mac App (IPC):** `mac-app/mac-app-ipc-logs.log`
- **Research (edge functions):** `research/research-logs.log`
- **Docs:** `docs/docs-logs.log`

**Prod logs (for benchmark agents):** Benchmark runs auto-collect logs from 3 prod sources into the result JSON (`agents/benchmarks/runs/*.json`):
- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **Fly.io (worker):** Agent execution logs (structlog JSON with `agent_id`) — streamed in real-time via `flyctl logs` during benchmark runs, needs `FLY_API_TOKEN` in `agents/.env`
- **Supabase (research):** Rose API gateway logs (completions, API key validation) — via `SUPABASE_ACCESS_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.

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

## LLM Call Map

Every LLM call in the agent pipeline, ordered by execution flow.

### Agent Pipeline (agents/, runs inside Temporal)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| A1 | **Main Loop (PLAN)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES | no | `build_system_prompt` (2k) + user_context (200-15k) + 4 PLAN tool schemas (500t) + conversation + blueprints | 3-20k |
| A2 | **Planner LLM** `helpers/llm.py:call_planner_llm_activity` | agent.model | YES | no | `build_planner_system_prompt` (3k) + user_context + conversation. **skip_cache=True** | 5-15k |
| A3 | **Verifier (PLAN)** `helpers/llm.py:check_progress` | agent.model | YES | no | `build_verifier_prompt` (500t) + full conversation (USER+TOOL only, no SYSTEM/ASSISTANT) | 3-40k |
| A4 | **Main Loop (EXECUTE)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES | no | `build_system_prompt` (2k) + user_context (200-15k) + 6 EXECUTE tool schemas (800t) + full conversation + DAG results | 5-80k |
| A5 | **Verifier (EXECUTE)** `helpers/llm.py:check_progress` | agent.model | YES | no | Same as A3 but with execute-phase conversation | 5-80k |

### Sub-Agent LLM Calls (spawned from EXECUTE phase)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| S1 | **Explore Agent** `tools/spawn_agent.py` → `run_agent` | rose-1-lite | **NO** | no | `EXPLORE_AGENT_SYSTEM_PROMPT` (300t) + **network_metadata (2k contacts, 5-15k t)** + local_data_summary + 4 tools (web_search, web_fetch, grep, attempt_completion) | 2-25k |
| S2 | **Browser Agent** `tools/spawn_browser_agent_v3.py` → `call_llm_structured_streaming` | agent.model | YES | no | `build_browser_system_prompt` (400t) + step history + screenshots (multimodal, heavy) | 5-30k |
| S3 | **Sub-Agent** spawns full workflow (A1-A5 repeat) | parent.model | YES | no | Inherits parent user_context (gatable via context_gates) + own conversation | recursive |

### Tool-Level LLM Calls (inside activities)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| T1 | **message_person** `tools/message_person.py` → `call_llm` | agent.model | **NO** | no | system prompt with conversation history + person thread + user message | 1-5k |
| T2 | **Deep Research** `tools/deep_research.py` → Perplexity API | sonar-deep-research | N/A | N/A | system prompt + query (separate provider, separate billing) | ~500 in, 8k out |

### claudeAuth Flow
- User's Claude OAuth token fetched at workflow start (`fetch_claude_max_token_activity`)
- Passed to Rose completions endpoint as `claude_token` param
- Rose routes directly to Anthropic API, skipping racing ($0 cost to Rose)
- Detected in response: `actual_model` ending with `-claude` suffix (e.g. `claude-sonnet-4-6-claude`)
- Refreshed before EXECUTE phase in case it expired during PLAN

### Context Gates per LLM Call

Each LLM call site, the context chunks it receives, and which `context_gates` key controls each chunk.

**Gate keys:** `user_profile`, `authenticated_sessions`, `integrations`, `recent_communications`, `network`, `custom_system_prompt`, `shared_files`

| LLM Call | Context Chunk | Gate Key | Est. Tokens | Notes |
|----------|--------------|----------|-------------|-------|
| **A1/A4 Main Loop** | user profile (name, phone, address) | `user_profile` | 50-100 | Via `get_user_context` → `build_system_prompt` |
| | authenticated browser sessions | `authenticated_sessions` | 20-50 | |
| | connected integrations (Gmail) | `integrations` | 20-30 | |
| | 200 recent messages (24h) | `recent_communications` | 2-10k | **Heaviest chunk** |
| | 2000 contacts network | `network` | 5-15k | **Heaviest chunk** |
| | custom system prompt | `custom_system_prompt` | 0-500 | User personality injection |
| | file attachment resolution | `shared_files` | variable | Base64 images, text files |
| | system prompt (identity, phase, tools, rules) | *always on* | 2-3k | `build_system_prompt` |
| | conversation history | *always on* | 1-50k | Grows per iteration |
| | blueprints | *always on* | 0-2k | Iteration 1 only |
| **A2 Planner** | user_context (pre-gated) | *inherits parent gates* | 0-15k | Same gates as A1 |
| | planner system prompt | *always on* | 3k | `build_planner_system_prompt` |
| | conversation history | *always on* | 1-10k | |
| **A3/A5 Verifier** | verifier system prompt | *always on* | 500 | `build_verifier_prompt` |
| | full conversation (USER+TOOL) | *always on* | 3-80k | No gates, no truncation |
| **S1 Explore** | 500-contact network metadata | `network` | 5-15k | Via `fetch_full_network_metadata` |
| | local message thread summary | `recent_communications` | 0-2k | Via `fetch_local_data_summary` |
| | explore system prompt | *always on* | 300 | `EXPLORE_AGENT_SYSTEM_PROMPT` |
| | 4 tool schemas | *always on* | 400 | web_search, web_fetch, grep, attempt_completion |
| **S2 Browser** | browser system prompt | *always on* | 400 | `build_browser_system_prompt` |
| | step history + screenshots | *always on* | 5-30k | No user context, no gates |
| **S3 Sub-Agent** | *all chunks from A1* | *inherits parent gates* | recursive | Gates set by parent's `spawn_agent` call |
| **T1 message_person** | cross-contact voice sample | `recent_communications` | 1-5k | `fetch_recent_messages_activity` |
| | 1-on-1 thread with person | *always on* | 0-3k | Always needed for context |
| | Exa person enrichment | *always on* | 0-1k | Always needed for personalization |
| **T2 Deep Research** | system prompt + query | *always on* | ~500 | Perplexity, separate billing |

### Remaining Waste (not gatable)
1. **A3/A5 Verifier** - Gets full conversation with no truncation. On long runs (20+ iterations) this balloons to 40-80k. Not yet gated.
2. **T1 message_person** - `call_llm` doesn't pass `claude_token`. Small per-call cost.
3. **Schema gen** (`setResponseSchema.ts`) - Forces Rose Ultra for a simple task. Rose Lite would suffice.

## Claude Code Review (MANDATORY)

Every PR must pass a Claude Code Review before merging. The review runs automatically as a GitHub Action (`.github/workflows/claude-code-review.yml`) on PR open/synchronize/reopen.

**How it works:**
- Uses `anthropics/claude-code-action@v1` with the `code-review@claude-code-plugins` plugin
- Triggers on: `opened`, `synchronize`, `ready_for_review`, `reopened`
- Two-tier jobs: `deep-review` (new/reopened PRs, `--effort max`) and `incremental-review` (subsequent pushes, `--effort medium`)

**Loop — run this after every `gh pr create`:**
```
1. Push branch + create PR
2. Poll check status via `gh pr checks <N> --json name,state,conclusion`
   - Wait for the "Claude Code Review" check to reach COMPLETED (max 60s, poll every 30s)
3. Read the review:
   - `gh api repos/<owner/repo>/pulls/<N>/reviews` → bot reviews
   - `gh api repos/<owner/repo>/pulls/<N>/comments` → inline comments
4. Check review state:
   - APPROVED → PASS, proceed to merge
   - CHANGES_REQUESTED → fix critical issues, push (triggers new review), go to step 2
   - COMMENTED / no review → ask user whether to fix or skip
5. If review doesn't complete within 60s, proceed with a note that review is pending
```

**Passing criteria:** Review state is APPROVED, or user explicitly skips. Fix critical issues. Skip menial/style nits.

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.
