# AGENTS.md

**Read `CLAUDE.md` first — it is the source of truth** for priorities, hard
rules, testing, benchmarks and production, and it is auto-loaded for every
Claude agent. Use the repo's own skills by default: the `.claude/commands/*`
slash-commands (`/deploy`, `/RCA`, `/benchmark`, …) and the `docs/` guides they
reference (e.g. `docs/root-cause-analysis.md`, `docs/testing.md`). Do not
duplicate that guidance here.

Before editing files under `front-end/`, `back-end/` or `agents/`, read that
directory's `AGENTS.md` (a symlink to its `CLAUDE.md`).

Setup on Andy’s Mac: `docs/setup-mac.md` (authoritative env-file locations,
pinned toolchains, dependency reuse and isolated workspace databases). Do not
substitute example env files for the complete local secrets.

Cloud/Linux agents: run `bash scripts/cloud-init.sh`, then follow
`docs/testing.md` and `CLAUDE.md` → **"Credentials and environment"** (skip
`mac-app`, injected env vars override `.env`) and **"Database"** (system
Postgres).

## Cursor Cloud specific instructions

- **Update script:** `bash scripts/cloud-init.sh` (idempotent). When
  `AGENTS_ENV_B64` / `BACKEND_ENV_B64` are absent, it synthesizes `agents/.env` /
  `back-end/.env` from injected Cursor Secrets.
- **ngrok:** Keep both `NGROK_API_KEY` (secret token `FIRSTPART_SECONDPART`,
  **not** the `ak_…` key ID) and `NGROK_AUTHTOKEN` in Cursor Secrets. `cloud-init`
  syncs them into both `.env` files and runs `ngrok config add-authtoken`. Use
  `HOME=/home/ubuntu` — a polluted `HOME` (e.g. `/tmp/cf-home*`) breaks ngrok
  config lookup. `trycloudflare.com` is often NXDOMAIN here; reserved-domain /
  ephemeral ngrok is the reliable public-tunnel path. Prefer
  `ROSE_USE_SYSTEM_PG=true` when Docker overlay mounts fail on the Cloud VM.
- **mac-app:** skip on Linux (tests and `dev`). All other smoke gates remain
  mandatory unless the user overrides that specific gate.
- **Isolated stacks:** do not let `.cloud-env` force `CONDUCTOR_PORT=3001` onto
  benchmark/AgentCard stacks — `run.sh` / `run-bench` must keep per-run ports.
- **Durable FE + LLM dumps (multi-day):** Never cite ephemeral
  `localhost`/`ngrok` FE links or `file://…/.context/rendered-llm-dumps/…` as
  approval Evidence. After a bench/agent run, publish with
  `python3 scripts/publish_evidence_links.py --run-json <run.json> --agent-id <id>`
  (uploads the Hub bundle to prod if needed, verifies
  `https://www.roselabs.ai/?agent-id=<id>`, fails closed unless every browser
  agent on that FE link is terminated with recording attached, writes the last
  LLM dump under `/opt/cursor/artifacts/rca_evidence/<id>/`). Do not cite
  `/open-agent` unless it redirects into `/?agent-id=` — a bare `/open-agent`
  path historically rendered SPA NotFound while HTTP stayed 200. Local benches
  dual-write terminal Hub bundles to prod automatically; Cloud Agents fail
  closed if that mirror fails.
- Standard run/test commands: `CLAUDE.md` + `docs/testing.md`.
