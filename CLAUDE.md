# Rose Labs

AI agent platform with model racing infrastructure.
- Production: https://roselabs.ai
- Backend API: https://navi-j9a9.onrender.com

## Architecture

```
front-end/     → React/TypeScript/Vite (Vercel)
back-end/      → Express/TypeScript/Prisma (Render)
agents/        → Python Temporal workers (Fly.io)
research/      → Model development (rose-1-lite, rose-1-ultra)
```

**Key entry points:**
- `front-end/src/App.tsx` - React app
- `back-end/src/server.ts` - Express server
- `agents/worker.py` - Temporal worker
- `agents/workflows/agent_workflow.py` - Core agent logic
- `back-end/prisma/schema.prisma` - Database schema (source of truth)
- `research/supabase/functions/completions/index.ts` - Rose model racing endpoint
- `research/supabase/functions/cost/index.ts` - Cost calculation

## Development

Run all services via Conductor (see `conductor.json`).

**Tests:**
```bash
cd back-end && npm run test:api         # Backend API tests
cd agents && python tests/run_all_tests.py  # Agent tool tests
```

## Log Files

Check these when errors occur:
- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`

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

## Temporal/Agent Patterns

- Workflows must be **deterministic** - no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** - safe on retry
- Error handling: catch → format → yield error event → **don't raise**
- See `agents/tools/base.py` for ToolManager pattern

## Test Credentials (Dev)

- Supabase URL: `https://kzlurqihzaolhzsbkctf.supabase.co`
- Test phone: `+19729777432`
- Test OTP: `181818`

## Database

- **ORM:** Prisma
- **RLS:** Enabled on all tables - users only see their own data
- Schema changes: Edit `back-end/prisma/schema.prisma`, then migrate
