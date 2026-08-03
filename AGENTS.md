# AGENTS.md

**Read `CLAUDE.md` first — it is the source of truth** for architecture, dev/setup,
testing, and the critical rules, and it is auto-loaded for every agent. Use the
repo's own skills by default: the `.claude/commands/*` slash-commands (`/deploy`,
`/RCA`, `/benchmark`, …) and the `docs/` guides they reference (e.g.
`docs/root-cause-analysis.md`, `docs/testing.md`). Do not duplicate that guidance
here.

Cloud/Linux agents: see `CLAUDE.md` → **"Cursor Cloud / Linux dev environment"**
(setup via `bash scripts/cloud-build.sh`, system Postgres, skip `mac-app`,
injected-env-vars-override-`.env` gotchas, and which test suites need funded/live
accounts).
