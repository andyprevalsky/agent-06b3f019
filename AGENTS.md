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

You can exercise the core API without a browser using the dev API key from
`CLAUDE.md` (X-API-Key path), e.g. `GET /health`, `GET /api/agents`, and
`POST /api/agents` all work against local Postgres.

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
