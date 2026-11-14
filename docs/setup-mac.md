# Setup on Andy's Mac

Fresh clone, local stack and disk hygiene on macOS. Linux devboxes use
`bash scripts/cloud-init.sh` instead and never install or run `mac-app/`.

## Fresh clone

- Clone outside iCloud-synced Desktop/Documents, e.g. `~/Developer/<unique-clone-name>`: evicted `dataless` files stall Git and Python (a pack can look empty while `ls` shows its full size), and Finder's **Keep Downloaded** does not repair a stalled sync.
- Env files are not committed. Copy or symlink `agents/.env`, `back-end/.env`, `front-end/.env`, `mac-app/.env` (and `research/.env` for research) from `/Users/andyprevalsky/conductor/repos/navi-whisper-lux-v2/` to the same relative paths; never print or commit them. `.env.example` files are references, not substitutes.
- Check that `BACKEND_API_KEY` is set and identical in both files without printing it: `agents/venv/bin/python -c 'from dotenv import dotenv_values as d; a=d("agents/.env").get("BACKEND_API_KEY"); print(bool(a) and a == d("back-end/.env").get("BACKEND_API_KEY"))'`.
- Reuse before installing: when a healthy checkout (e.g. `~/Developer/rose-pr1299`) has the same root/workspace `package.json` files, lockfiles, `agents/requirements.txt`, platform and toolchains, link its root `node_modules` **and** each package's `node_modules`, plus `agents/venv`, into the same relative paths. npm workspaces hoist packages such as `dotenv` into the root tree, so package trees alone are incomplete. Activate the reused venv so child `python3` uses it.
- Toolchains: start Docker Desktop; Python **3.11.9** for `agents/venv` (select it explicitly when an asdf shim points elsewhere); Node **22.13.0** (verified) for `back-end/` and `front-end/`; Node **20.10.0** for `mac-app/` (`source ~/.nvm/nvm.sh && nvm install 20.10.0 && nvm use 20.10.0`).
- Fleet controllers need modern Bash: `brew install bash` and put `/opt/homebrew/bin` before `/bin`; macOS Bash 3.2 lacks `mapfile` and associative arrays.
- Fresh install when nothing can be reused: `npm install` in `back-end/`, `front-end/` and `mac-app/`; from `agents/`, `python3.11 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`; then `bash scripts/sync-reference-repos.sh`.
- If pip's resolver stalls: `uv pip install --python agents/venv/bin/python -r agents/requirements.txt` (same venv, same requirements). If npm workspace resolution fails: `npm ci --workspaces=false` in `back-end/` and `front-end/`; never delete lockfiles or change ranges.
- After installing backend dependencies, run `npx prisma generate` in `back-end/` before database setup; a schema push does not generate the client the seed and index scripts use.
- Before browser blackbox tests, inside the activated venv: `python -m playwright install chromium`.

## Local stack (standalone clone)

`scripts/run.sh` and `scripts/setup-db.sh` take the workspace identity from these variables (Linux reads `.cloud-env`). Pick an unused base port and a unique name (normally the directory basename) and use the same values for both:

```bash
export CONDUCTOR_PORT=<unused-base-port> CONDUCTOR_WORKSPACE_NAME=<clone-directory-name> CONDUCTOR_ROOT_PATH="$PWD"
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
bash scripts/setup-db.sh && bash scripts/run.sh
```

- `setup-db.sh` resets only this workspace's local Postgres database and seeds it from production (needs the prod DB credentials in `back-end/.env`); never reuse another workspace's name or ports.
- The `NO_PROXY` exclusions keep Python's local health and test requests local under a macOS system HTTP proxy; don't disable the user's proxy app.
- Local system-Postgres benches need matching client tools on `PATH` after selecting Node: for Homebrew PostgreSQL 17 prepend `/opt/homebrew/opt/postgresql@17/bin`, because a Postgres.app PG18 client selects a different canonical seed-cache key.
- If the PG17 seed cache is missing, restore the reviewed canonical fixture into an isolated PG17 database, verify table content and a dump/restore round trip, then publish that version's key.

## Disk hygiene (after a deploy or benchmark session)

On 2026-10-06 the 926 GB data volume hit 100%: Docker Desktop wedged in `Docker: stopping`, every workspace lost its DB container and a smoke lane died with `ENOSPC`. Check `df -h /System/Volumes/Data` before heavy local gates or benchmarks, clean up when done, and touch only your own workspace's `.context` (never another workspace's, never Freedom).

- This workspace: `rm -rf .context/benchmarks/<run-id>` for finished isolated runs once the pid in `local-stack-owner.json` is gone (keep `seed-cache`); `rm -rf .context/frontend-builds/<run-id>` (~400 MB each); `git worktree remove --force .context/main-tree && git worktree prune` if you created a main-comparison worktree.
- Chats older than a week: gzip and keep the `.gz` (`find ~/.claude/projects -name '*.jsonl' -mtime +7 -exec gzip -9 {} +`, same for `~/.codex/sessions`).
- `~/.claude/gen/codex/transcripts` is already gzip; delete entries older than a week only when today's `~/.claude/gen/codex/events/<date>.codex_uploader.jsonl` shows `upload.cycle` `"ok":true` with an empty spool.
- Docker: only `docker builder prune -f` and `docker image prune -f`; never `docker system prune` (it removes other workspaces' stopped DB containers). `Docker.raw` (~115 GB) holds every workspace's volumes.
- Safe to delete: updater staging `/var/folders/*/T/*.ShipIt.*` and `~/Library/Caches/*ShipIt*`. Keep `~/Library/Caches/ms-playwright` (tests need it) and running apps' caches.
- Ask before removing these large but functional paths: Claude desktop `vm_bundles/claudevm.bundle` (10 GB), Cursor `User/globalStorage` (8.6 GB), `~/.codex/thread_history_*.sqlite`.
- Wedged Docker: `osascript -e 'quit app "Docker Desktop"'`, `pkill -TERM -f com.docker.backend` only if it lingers, `open -a Docker`, then `docker start victoria-db-<workspace>` (containers come back `Exited (255)`).
