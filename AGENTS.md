# AGENTS.md

Repository overview and conventions live in `CLAUDE.md` (architecture, services,
testing, and critical rules). Read it first. This file adds only Cursor Cloud
environment specifics.

## Cursor Cloud specific instructions

This is a monorepo: `back-end/` (Express/TS/Prisma), `front-end/` (Vite/React),
`agents/` (Python Temporal worker), plus `mac-app/` (Electron, macOS-only —
skip on Linux). The update script already installs JS deps (`npm install` at the
root, which runs the workspace postinstalls: Prisma client generate + Playwright
chromium) and the Python venv (`agents/venv`, built with `python3.11`).

### Local Postgres (system, not Docker)
- Docker is NOT installed here; the stack uses **system PostgreSQL 16** at
  `localhost:5432`, user/password `postgres`/`postgres`, database `victoria`.
- If it isn't running, start it: `sudo service postgresql start` (or
  `sudo pg_ctlcluster 16 main start`). `scripts/run.sh` and the backend blackbox
  runner both auto-fall back to system Postgres when Docker is absent.

### Dev `.env` files
- `back-end/.env`, `front-end/.env`, `agents/.env` exist with dev/public values
  (from `CLAUDE.md` Test Credentials + `.env.example`) and **placeholders** for
  secrets not available in this cloud VM. `DATABASE_URL` points at the local
  Postgres so nothing touches prod. These files are gitignored (persist via the
  VM snapshot, not the repo).
- Real functionality that needs actual secrets (fill these in to unblock):
  `TEMPORAL_API_KEY` (live workflows), `OPENROUTER_API_KEY`/`GPT_API_KEY`/
  `CEREBRAS_API_KEY`/`ANTHROPIC_API_KEY` (model racing — an agent run FAILS at
  the LLM boundary without them), `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_JWT_SECRET`
  (session creation / JWT verify — OTP login can't complete without them),
  plus tool keys (`SERPER_API_KEY`, `FIRECRAWL_API_KEY`, `E2B_API_KEY`,
  `KERNEL_API_KEY`/`STEEL_API_KEY`, `STRIPE_*`, `PLAID_*`, `AGENTCARD_*`).

### Running services individually (reliable path, no ngrok/secrets)
Prefer running the dev servers directly rather than `scripts/run.sh` (that script
additionally requires ngrok for a public tunnel and real prod Supabase/Temporal
creds for its prod-data seed — not available here).
- Backend: `cd back-end && DISABLE_GMAIL_SYNC=1 PORT=3001 npx tsx watch src/bootstrap.ts`
  (or `npm run dev`). Boots against local Postgres and serves `/health` + the API.
  The `[Temporal] client prewarm failed` warning is expected with a placeholder
  key and is non-fatal.
- Frontend: `cd front-end && npx vite --port 3002`.
  - **Port pairing gotcha:** in dev the frontend infers the backend origin as
    `frontendPort - 1` (see `front-end/src/lib/backendUrl.ts`) unless
    `VITE_BACKEND_API_URL` is set to a non-default value. So run backend on port
    `N` and frontend on `N+1` (e.g. `3001`/`3002`). This mirrors `run.sh`
    (backend=base, frontend=base+1).
  - **CORS gotcha:** the backend only accepts browser requests from origins in
    `ALLOWED_ORIGINS`. The committed `.env.example` lists `8080`/`5173`; the dev
    `back-end/.env` here also includes `http://localhost:3002` so the `3001/3002`
    pairing works in the browser. `run.sh` sets `ALLOWED_ORIGINS` to the frontend
    port automatically. `.env` changes require a backend restart (`tsx watch`
    does not reload `.env`).
- Agents worker: `cd agents && source venv/bin/activate && ./scripts/run_local_worker.sh`
  — needs a real `TEMPORAL_API_KEY`; it will not connect with the placeholder.
  Worker logs go to `agents/navi-worker-log.txt` (not the shell), per
  `run_local_worker.sh`.

You can exercise the core API without a browser using the dev API key from
`CLAUDE.md` (X-API-Key path), e.g. `GET /health`, `GET /api/agents`, and
`POST /api/agents` all work against local Postgres.

### ⚠️ Temporal task-queue isolation (critical)
The VM environment injects a `TEMPORAL_TASK_QUEUE` value that points at a
**shared** queue on the shared Temporal Cloud namespace (a `navi-agent-tasks`
variant used by CI/test runs). Node's `dotenv.config()` and Python's
`load_dotenv(override=False)` both keep a pre-existing env var over `.env`, so
the backend AND worker will silently inherit that shared queue and start
consuming OTHER runs' workflows (observed: a local worker picked up dozens of
foreign test `AgentWorkflow`s and failed their activities). Before starting the
backend or worker for real agent runs, **export a unique queue in both shells**,
e.g. `export TEMPORAL_TASK_QUEUE=navi-agent-tasks-<something-unique>` (this is
exactly what `run.sh` does via `CONDUCTOR_WORKSPACE_NAME`). Never run a local
worker on the injected shared queue or the bare `navi-agent-tasks` prod queue.

### Full agent stack with real secrets
With real secrets in the environment, the dev `.env` writer picks them up.
Verified end-to-end here:
- Full OTP login works: test phone `+19729777432`, OTP `181818`; the waitlist
  gate is bypassed with invite code `181818` (`WAITLIST_BYPASS_INVITE_CODE`).
- A chat-mode agent (`POST /api/agents` with NO `start_phase`) completes cleanly
  via the backend Rose completion path and returns a real answer (its reply text
  lands in message `metadata.attentionMessage` / `sendMessageToUser`).
- Temporal agents run: `POST /api/agents` with `start_phase` (or the UI goal box)
  starts a real workflow on the isolated queue and the worker executes it with
  real LLM inference (Rose waterfall via OpenRouter/Cerebras). The autonomous
  plan→execute loop currently tends to fail late (`rose-1-ultra` pool waterfall /
  "Code session failed") in this local setup even though it produces the correct
  reasoning; that is an agent-harness/model-pool robustness matter, not an
  environment problem. The local DB has no `User` row for the test user, so
  `get_user_context` logs a non-fatal error.

### Tests
See `docs/testing.md` and `CLAUDE.md` for the full command list. Offline suites
that need no secrets and pass here: `back-end` `npm run lint` + `npm run test:structural`
+ `bash scripts/run-blackbox-tests.sh` (self-starts a backend on local Postgres),
`front-end` `bash scripts/run-blackbox-tests.sh`, and `agents`
`python scripts/run_blackbox_tests.py`. Known secret-gated exceptions:
- Agents blackbox domains `attachments` and `benchmark` fail without a real
  `SUPABASE_SERVICE_ROLE_KEY` / LLM keys (the other ~88 pass).
- `front-end` `npm run lint` reports a few pre-existing `max-lines` errors on
  `main` (a codebase state, not an environment problem).
- Python is 3.11 via `agents/venv` (system `python3` is 3.12; the project pins 3.11).
