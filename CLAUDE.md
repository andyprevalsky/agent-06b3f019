WHEN COMMUNICATING TO THE USER, BE CONCISE, LET THE USER ASK FOR MORE CONTEXT IF THE USER WANTS MORE, OTHERWISE DO NOT OVERCOMMUNICATE. STRICTLY FOLLOWING USER COMMUNICATION PROTOCOL

# Rose Labs

AI agent platform.

- Production: https://roselabs.ai
- Backend API: https://navi-j9a9.onrender.com
- API Docs: https://docs.roselabs.ai

## Architecture

```
front-end/        → React/TypeScript/Vite (Vercel)
back-end/         → Express/TypeScript/Prisma (Render)
agents/           → Python Temporal workers (Fly.io)
research/gepa/    → Offline reward-model pipeline (no runtime services)
mac-app/          → Electron desktop app (macOS only)
docs/             → API documentation (Mintlify)
claude-code-src/  → Vendored Claude Code source (READ-ONLY reference). Its
                    prompts and agent loop are extensively battle-tested;
                    our repo is still at the 0-users stage. Lift patterns
                    liberally when designing or refining our agent harness.
openclaw/         → Cloned OpenClaw repo (READ-ONLY reference, gitignored —
                    not committed to keep parent repo lean). Open-source
                    agent harness; useful prior art for tool layouts, system
                    prompts, and orchestration patterns. Re-clone with
                    `git clone --depth 1 https://github.com/openclaw/openclaw.git`
                    if missing locally.
hermes-agent/     → Cloned Nous Research hermes-agent (READ-ONLY reference,
                    gitignored). Reference implementation for tool-calling
                    + reasoning prompts. Re-clone with
                    `git clone --depth 1 https://github.com/nousresearch/hermes-agent.git`
                    if missing locally.
codex/            → Cloned OpenAI Codex CLI (READ-ONLY reference, gitignored,
                    Apache-2.0). Terminal coding agent harness; prompts live
                    under `codex-rs/prompts/` + `codex-rs/core/*_prompt.md`.
                    Re-clone with
                    `git clone --depth 1 https://github.com/openai/codex.git`
                    if missing locally.
prime-agent/      → Cloned Prime Intellect prime-agent (READ-ONLY reference,
                    gitignored, MIT). Recursive-language-model harness: one
                    persistent Python REPL tool, every other tool/subagent a
                    Python call, plus self-edited memories/skills. System
                    prompt layers live under
                    `crates/pa-core/src/prompts/layers/`, skills under
                    `skills/`, the kernel under `prime-agent-runtime/src/rlm/`.
                    Re-clone with
                    `git clone --depth 1 https://github.com/PrimeIntellect-ai/prime-agent.git`
                    if missing locally.
```

> **Reference repos policy:** `openclaw/`, `hermes-agent/`, `codex/`, and `prime-agent/` are gitignored
> (sit alongside `claude-code-src/` but are NOT committed). Treat as
> read-only research material — do not edit them. If they're missing on a
> fresh clone, run `bash scripts/sync-reference-repos.sh` to restore.

## Prompt review tool

`prompt-review/` ships a small local web app for reviewing every prompt in
this repo against reference codebases side by side. Columns:
**current → ~1 month ago → Claude Code → OpenClaw → Hermes → Codex → Prime Agent**. Notes are
saved per prompt; checkpoint state persists across reloads.

```bash
bash prompt-review/run.sh                     # rebuilds data + launches on :8765
PROMPT_REVIEW_PORT=9000 bash prompt-review/run.sh   # custom port
```

- Catalog: `prompt-review/catalog.json` (edit to add/remove prompts).
  Each OUR entry has a `matches` field with hand-picked semantic pairings
  for each reference repo (`claude`, `openclaw`, `hermes`, `codex`, `prime`); a value of
  `null` means "no equivalent in that repo" and the column shows
  "no equivalent" instead of a low-quality keyword match. Edit
  `prompt-review/render/apply_explicit_mappings.py` to refine pairings.
- Build: `python3 prompt-review/build.py` (extracts text + git history +
  resolves matches via explicit mapping first, keyword fallback otherwise).
- Notes/checkpoints: `prompt-review/checkpoints/state.json` (gitignored)
- Weak matches (no good correlary in the reference repo) get a teal `WEAK`
  flag in the column header. Match-source badges: blue `manual` (explicit
  semantic pairing) vs gray `auto` (keyword fallback).

**Key entry points:**

- `front-end/src/App.tsx` - React app
- `back-end/src/server.ts` - Express server
- `agents/worker.py` - Temporal worker
- `agents/workflows/agent_workflow.py` - Core agent logic
- `back-end/prisma/schema.prisma` - Database schema (source of truth)
- `back-end/src/providers/rose/client.ts` - In-process Rose completions (chat path)
- `agents/providers/rose/client.py` - In-process Rose completions (agents path)
- `mac-app/main/index.ts` - Electron main process
- `docs/mint.json` - Mintlify docs config

**Mac app releases:** PRs that include `mac-app/` changes should be labeled `MAC-APP-RELEASE`. When a PR with this label is merged, CI automatically bumps the patch version, creates a git tag, and pushes it — which triggers the full release workflow (build, sign, notarize, upload). No manual tagging needed. You can also trigger a release manually by pushing a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`). **Any `front-end/` changes also require a mac-app version bump** (new git tag push) so the Electron app rebuilds with the updated frontend.

## Development

Run all services via Conductor (see `conductor.json`).

### Fresh clone setup (Andy’s Mac)

Read this file completely and honor `AGENTS.md` before setup. Secrets are not
committed. The authoritative local env files live under
`/Users/andyprevalsky/conductor/repos/navi-whisper-lux-v2/`. Copy or symlink
`agents/.env`, `back-end/.env`, and `front-end/.env` into the same relative
paths in the clone; also restore `mac-app/.env` on macOS and `research/.env`
when doing research. Never print or commit their contents. Verify that
`BACKEND_API_KEY` is present and agrees between agents and backend without
printing it. The `.env.example` files are safe references, not complete
substitutes for the authoritative files. For credential reconciliation, follow
**Production Env Vars** below, including the Codex-cloud `rose` environment.
Exact cloud cancellation must also read the browser provider credentials from
these env files. Its credential loader accepts a symlink to a regular
authoritative env file; cleanup evidence and receipts remain symlink-free. If
recovering an older controller that rejects linked env files, materialize
private `0600` copies before retrying its exact-owner recovery.

Keep the checkout outside iCloud-synced Desktop or Documents; prefer
`~/Developer/<unique-clone-name>`. Evicted `dataless` files can stall Git and
Python or make a Git pack appear empty even though `ls` reports its full logical
size. Finder's **Keep Downloaded** does not repair an already stalled iCloud
sync; a fresh clone on local storage avoids that dependency.

Start Docker Desktop. Use Python **3.11.9** for `agents/venv` and Node
**20.10.0** for the Mac app (`source ~/.nvm/nvm.sh`, `nvm install 20.10.0`,
`nvm use 20.10.0`). Select the installed Python 3.11.9 explicitly when an asdf
shim points elsewhere. Install backend, frontend, and Mac app dependencies in
their package directories with `npm install`; create `agents/venv` with
`python3.11 -m venv venv` from `agents/`, activate it, and run
`pip install -r requirements.txt`. Run `bash scripts/sync-reference-repos.sh`.
Fleet controllers require modern Bash (`brew install bash`, then put
`/opt/homebrew/bin` before `/bin` on Apple Silicon); macOS’s bundled Bash 3.2
does not provide their `mapfile`/associative-array operations.
Backend/frontend dependencies may require a newer Node than the Mac app; use
an installed compatible Node (22.13.0 was verified) for those packages and
retain 20.10.0 for `mac-app`.
Isolated macOS benchmarks use a separate Docker Postgres server per run. Keep
the automatic system-Postgres fallback limited to Linux; separate databases on
one system server still share its connection limit during parallel smoke runs.
Keep the Mac awake during long validations. `caffeinate -is` prevents idle sleep,
but closing the lid on battery can still suspend the controller and local
WebSockets while cloud tasks continue. Check `pmset -g log` before treating a
long wall-clock gap as a provider timeout.

If npm workspace resolution fails, use each package’s committed lockfile with
`npm ci --workspaces=false` in `back-end/` and `front-end/`, as documented in
the RCA `2026-07-24-root-npm-install-ignored-workspace-lockfiles`. Do not delete
lockfiles or change dependency ranges to get a fresh clone installed. If pip’s
resolver stalls, `uv pip install --python agents/venv/bin/python -r
agents/requirements.txt` installs the same requirements into the same venv.
After installing backend dependencies, run `npx prisma generate` from
`back-end/` before database setup; schema push alone does not generate the
client used by the seed/index scripts.
For direct agent tests, run from `agents/` with `source venv/bin/activate`;
an absolute venv Python alone leaves subprocess `python3` on the asdf shim.
Install the matching browser once with `python -m playwright install chromium`
inside that activated venv before browser blackbox tests.
Use the browser-use version pinned in `agents/requirements.txt`: native
navigation must forward the event's timeout to CDP. The browser blackbox checks
that actual path and rejects a global asyncio patch. Resolve Python dependency
changes against the complete manifest and run `python -m pip check` before
refreshing cloud dependency snapshots; an old pool fingerprint cannot certify
the new environment.
On Mac, a failed Docker database setup must stop before any shared-system-PG
reset. `scripts/tests/setup-db-concurrency.test.sh` covers that boundary.
For explicit isolated coverage URLs, use `BACKEND_COVERAGE_DATABASE_URL` with
a local `victoria_<workspace>` database inside a verified owned server.
The worker blackbox covers optional CDP timeouts, recording cleanup drain and
strict rejection of unrelated pending tasks; expired optional CDP children
remain owned by the bounded worker event-loop shutdown.

In Conductor, use `.conductor/settings.toml`; it supplies workspace variables,
links env files from `$CONDUCTOR_ROOT_PATH`, and runs `scripts/setup-db.sh`.
For a standalone clone, choose an unused base port and a unique directory name
(the workspace name normally matches the directory basename), then run:

```bash
export CONDUCTOR_PORT=<unused-base-port>
export CONDUCTOR_WORKSPACE_NAME=<clone-directory-name>
export CONDUCTOR_ROOT_PATH="$PWD"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
bash scripts/setup-db.sh
bash scripts/run.sh
```

Use the same variables for setup and startup. Setup resets only that workspace’s
local Postgres database and seeds it from production; the backend env must have
production DB credentials. Do not reuse another workspace’s name or ports.
The loopback proxy exclusions keep Python local health/test requests local
when macOS has a system HTTP proxy; do not disable the user's proxy application.
For Linux/cloud, use **Cursor Cloud / Linux dev environment** below instead:
prefer complete `AGENTS_ENV_B64` / `BACKEND_ENV_B64` secrets (optional SHA256
checks), configure both ngrok secrets, run `bash scripts/cloud-init.sh`, and
never install or run `mac-app` there.

A schema change can require a new canonical cloud seed cache key. Cloud guests
use PostgreSQL 15: migrate the previous reviewed canonical fixture in an
isolated PG15 database, preserve its row content, and validate with
`scripts/validate-canonical-seed-dump.sh` before publishing via
`back-end/scripts/seed-dump-cache.ts`. Use `scripts/save-seed-dump.sh` with that
PG15 container and verify a restore/read-back. Never publish a coverage database
or replace the reviewed WhatsApp history with a production cold sync. See
`docs/rca/cases/2026-08-20-poisoned-canonical-seed-missing-whatsapp-history.md`.
Local system-Postgres benches need the matching client tools on `PATH` after
selecting Node. For a Homebrew PostgreSQL 17 server, prepend
`/opt/homebrew/opt/postgresql@17/bin`; a PostgreSQL 18 client from Postgres.app
otherwise selects a different canonical cache key. If a PG17 cache is missing,
restore the reviewed canonical fixture into an isolated PG17 database, verify
table content and a dump/restore round trip, then publish that version's key.

### Disk hygiene after a deploy/benchmark session (Andy’s Mac)

The 926 GB data volume filled to 100% on 2026-10-06 and Docker Desktop wedged
in `Docker: stopping` (every workspace lost its DB container; a smoke lane died
with `ENOSPC`). Check `df -h /System/Volumes/Data` before Group 3/4 lanes and
clean up when you finish. Only touch your own workspace’s `.context`, never
another workspace’s, never Freedom.

- **This workspace:** `rm -rf .context/benchmarks/<run-id>` for finished
  isolated runs (keep `seed-cache`; check `local-stack-owner.json` pid is gone),
  `rm -rf .context/frontend-builds/<run-id>` (~400 MB each), and
  `git worktree remove --force .context/main-tree && git worktree prune` if a
  main-comparison worktree was created.
- **Chats older than one week — compress, keep, destroy the raw:** Claude Code
  `find ~/.claude/projects -name '*.jsonl' -mtime +7 -exec gzip -9 {} +`; Codex
  `find ~/.codex/sessions -name '*.jsonl' -mtime +7 -exec gzip -9 {} +`
  (`gzip` keeps the compressed file beside the old name and removes the raw).
  `~/.claude/gen/codex/transcripts` is already gzip; delete entries older than a
  week only when `~/.claude/gen/codex/events/<today>.codex_uploader.jsonl`
  shows `upload.cycle` `"ok":true` with an empty spool — the uploader was
  returning `server_5xx` on 2026-10-06, so those were kept.
- **Conductor chats** live in
  `~/Library/Application Support/com.conductor.app/conductor.db`
  (`session_messages`, 9.5 GB / 2.6 M rows in Oct 2026). Quit Conductor first,
  then archive and compact:
  `sqlite3 -readonly conductor.db ".mode json" "SELECT * FROM session_messages WHERE created_at < strftime('%s','now','-7 days')*1000" | gzip -9 > ~/Archives/conductor-chats/$(date +%F).jsonl.gz`,
  then `sqlite3 conductor.db "DELETE FROM session_messages WHERE created_at < strftime('%s','now','-7 days')*1000; VACUUM;"`
  (confirm the `created_at` unit with `SELECT MAX(created_at)` first; freelist
  is 0 without the delete, so `VACUUM` alone reclaims nothing).
- **Docker:** `docker builder prune -f` and `docker image prune -f` only.
  Never `docker system prune` — it removes other workspaces’ stopped DB
  containers. `Docker.raw` (~115 GB on disk) is every workspace’s volumes.
- **Updater leftovers are safe:** `/var/folders/*/T/*.ShipIt.*` and
  `~/Library/Caches/*ShipIt*` are stale app-update staging (GBs). Leave
  `~/Library/Caches/ms-playwright` (tests need it) and running apps’ caches.
- **Large but functional (ask before removing):** Claude desktop
  `vm_bundles/claudevm.bundle` (10 GB, re-downloadable), Cursor
  `User/globalStorage` (8.6 GB chat/AI state), `~/.codex/thread_history_*.sqlite`.
- If Docker is already wedged: `osascript -e 'quit app "Docker Desktop"'`,
  `pkill -TERM -f com.docker.backend` if it lingers, `open -a Docker`, then
  `docker start victoria-db-<workspace>` — containers come back `Exited (255)`.

**Tests:** See `docs/testing.md` for the full guide. Quick:

```bash
bash scripts/test.sh --port=3001                   # everything: offline + smoke + semantic (requires running services)
bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + semantic)
bash scripts/test.sh --no-smoke agents web-search  # single repo/domain (offline)
bash scripts/test.sh --list                        # list available repos/domains
```

**Backend tests (direct):**

```bash
cd back-end && npm run test:api         # Backend API tests
cd back-end && npm run test:coverage    # Backend coverage check (enforces thresholds)
cd back-end && npm run test:coverage:report  # Coverage report without threshold enforcement
cd front-end && npm run test            # Front-end blackbox + structural tests
cd front-end && npm run test:coverage   # Front-end coverage check (enforces thresholds)
cd front-end && npm run test:coverage:report  # Front-end detailed coverage report
cd mac-app && npm run test:coverage     # Mac-app coverage check (enforces thresholds)
cd mac-app && npm run test:coverage:report  # Mac-app detailed coverage report
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py  # Agent blackbox tests
cd agents && python tests/e2e/run_e2e_tests.py --basic  # E2E agent tests (spawns real agents via API)
cd agents && bash scripts/run-coverage.sh            # Agents coverage check (enforces fail_under)
cd agents && bash scripts/run-coverage.sh --report   # Detailed report without threshold
cd agents && bash scripts/run-coverage.sh --html     # HTML report in htmlcov/
cd mac-app && npm run test                   # Mac-app blackbox suite (vitest + MSW, jsdom)
cd mac-app && bash scripts/run-blackbox-tests.sh <domain>  # Mac-app blackbox: single domain
```

**Code coverage:**

- **Backend** requires minimum 88% line/statement, 87% function, 76% branch (see `back-end/.c8rc.json`).
- **Front-end** requires 80% lines, 75% statements/functions, 70% branches (see `front-end/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines, ~79% statements, ~77% functions, ~72% branches. Target: 80% across all four.
- **Mac app** requires 80% lines/statements/functions and 85% branches (see `mac-app/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines/statements, ~84% functions, ~85% branches. Thresholds ratchet up and never down.
- **Agents** requires 80% line+branch (see `agents/pyproject.toml` → `[tool.coverage.report]`). Current: 81%.
- Thresholds ratchet — only increase, never decrease. Bump after adding tests.

**Benchmarks:** `scripts/run-bench` is the one supported entrypoint for humans,
`/benchmark`, and `/descend`; see `agents/benchmarks/README.md` for the full CLI.
Use `scripts/run-bench list` to inspect tasks, then run a named slice or explicit
tasks with `scripts/run-bench <slice-or-task...>`. It defaults to the cloud
fleet, one isolated machine/world/queue per task. Use
`scripts/run-bench <task> -k K --concurrency N` (equivalently `--runs K`) for K
independent copies with at most N active; never repeat a task by passing duplicate
names to one fleet. Named slices are `daily`, `pre-deploy`, `rose-bench`,
`polar-bench`, and `incomplete`.

The sequential `stability-proof` wrapper caps width at 32; `/deploy` selects at
most 20 tasks. Neither cap defines the width of an explicitly requested ordinary
fleet: resolve its concrete names and pass them together to `scripts/run-bench`
without `-k` or `--concurrency`. Check current provider capacity and controller
CPU/disk, then retain one batch and measure actual execution and LLM concurrency.
Do not substitute smaller slices for a requested wide slice. Larger live stress
runs remain explicitly requested validations, not automatic deploy stages.

After explicitly destroying a released pool, preserve its ownership history and
remove only the exact, natively verified retired IDs from the active git-common
`cloudbench-pools/<workspace>.ids` index. Historical IDs must not remain an active
pool: the worker-snapshot preflight correctly rejects an indexed Machine missing
from provider inventory. Never prune on an observation timeout or touch another
workspace's pool. An empty active index uses the existing verified warm snapshot.

Treat inner elapsed-time measurements as diagnostics, not independent success
criteria. Keep terminal outcomes, exact resource retirement and the end-to-end
deadline hard; use generous fixture host guards. Tiny synthetic deadlines that
exercise cancellation are test inputs, not acceptable production timing budgets.
For terminal-result/cleanup campaigns, use
`scripts/verify_successful_llm_queries.py --diagnostics-only` to retain reported
errors as warnings. Require meaningful real LLM calls (normally more than three; chat may need fewer), a terminal SUCCESS or
FAILURE (including an execution-window FAILURE), and exact owned-resource cleanup
within that historical campaign's 1800-second allocation deadline; do not force
extra model calls. The current width-fifty LIVE campaign uses the separate
execution and whole-run clocks documented in Eval Suite below.

**Cloud runner quick start:** From a configured clone, run
`scripts/run-bench list`, then `scripts/run-bench <task> --wait` for one real
isolated benchmark. For an infrastructure streak, use
`scripts/run-bench stability-proof -k 10 --concurrency 10 --seed <integer>
--exclude-file <prior-successful-names.json> --min-successful-llm 0`;
the exclusion file is a JSON array of task names already used in accepted
earlier runs. For the completed daily/Polar campaign, rebuild the eligible pool
on every return to slice zero. Keep all 100 tasks distinct within that campaign;
accepted and failed task names from earlier campaigns remain eligible.
Capability slices
are sampled without replacement across that command, and the command stops at
the first infrastructure failure. Add `--dry-sample` first to review all task
names and check smoke/non-Polar coverage; `--pool-file <ready-names.json>`
restricts eligibility when a proof has a specific task pool. Preserve the
printed run/proof directories and exact owner token. Never use duplicate task
arguments as a substitute for `-k`; `--concurrency` is tasks per slice, not
the number of sequential slices. The normal `--timeout` and benchmark
backstop are each 7,200 seconds. Only the current user-requested accelerated
validation uses `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300` and `--timeout 300`,
with the independent 30-minute end-to-end cutoff described below.
Capability proof selection excludes rootless SMS supervisor tasks: they have
no Temporal agent root to anchor an archive or correlate the required three
LLM completions. An explicit pool containing one fails before provisioning.
The SMS runner still verifies its own seeded-session cleanup for ordinary
benchmark runs; a missing root from any other runner remains an ownership
error. If a legacy rootless SMS guest fails before publishing its guest ACK,
exact-owner recovery requires the original run, complete backend log, and
quiescence receipt to prove zero root/browser/payment allocation. It grants
zero benchmark proof credit and refuses any observed external ownership.
Phone-persona tasks also need an exact assignment in
`BENCHMARK_CALLEE_PHONE_NUMBER_IDS` when that mapping is configured. Capability
sampling excludes unassigned phone tasks and rejects an explicit pool containing
one before provisioning; an unassigned guest otherwise produces no benchmark
result and can retain its pool owner. Reconcile the mapping in the authoritative
backend env before intentionally including that task. Do not invent a number or
change the task/evaluator to obtain infrastructure proof credit.

**If a run goes wrong:** Start with its `summary.json`, `_batch/run.json`,
`_batch/lifecycle.json`, per-task `cloudbench-run.json`, `fleet-child.log`,
`remote-logs/cloudbench-driver.log`, and `teardown-ownership` audit. Use
`/descend` for the exact HARNESS-versus-INFRA contract and `/RCA` plus
`docs/root-cause-analysis.md` for a failing path. A task `FAILED` verdict can
still satisfy an infrastructure proof; a missing result, missing successful
model responses, stale/foreign evidence, or unverified teardown cannot. Stop
only the exact controller PID/owner recorded for your run and let its traps
recover resources; use its exact stale-owner recovery path if needed.
Review the complete rejected slice together: the fleet waits for every child
before aggregating results. Batch independent infrastructure repairs and their
owning regression checks before freezing the source for a fresh streak.
For shell process ownership, capture births with `cloudbench_pid_start_time`;
its reader uses the same whitespace normalization. Raw `ps lstart` pads
single-digit days and can otherwise reject the live owner during cancellation.
If archive finalization reports `TimeoutError`, inspect the last
`browser_archive_observation`, exact `cloud_cleanup_evidence` session snapshots,
and worker cancellation timestamps before blaming recording upload. The
archive observation records `tree_fetch`, `agent_snapshots` (including completed
and expected IDs), or `browser_readiness` so a slow HTTP read can be separated
from a missing recording. Full-transcript snapshot reads use eight concurrent
slots per paused tree; they retain every agent and the existing archive bound.
Boot-mode terminal results come from the already sealed, owner/hash-verified
`remote-logs/runtime-evidence/run.json`, never a multi-megabyte JSON value
extracted from the progress log. A truncated log is diagnostic evidence;
missing or corrupt sealed files remain INFRA and retain the owner.
A browser tool canceled before allocating a session has no recording to attach; only a
task-bound `browser_zero_allocation_receipt` plus zero sessions in the exact
before/archive/after/final ownership reads and a clean provider receipt can
establish that exception. Any allocated session still owes a playable recording.
The durable publisher checks this proof; never synthesize a recording or waive
its check to grant a slice credit. If the provider replay exists but the FINISHED
recording message is missing, inspect `Failed to save browser action message` in
the worker log. Required recording attachments retry pre-request connection/pool
failures at most three times with the same payload and generation; ambiguous
read/write failures and HTTP rejections remain fail-closed. More archive wait
cannot repair an attachment that was discarded after a connection failure.
Closed network-body files publish automatically through the existing bounded
batch path while recording is open; changed or incompletely acknowledged files
retain their normal terminal fallback. Batch POST transport has a scoped
120-second read/write budget; ordinary single-artifact transport and task,
flush and allocation-to-release deadlines are unchanged. A late attempted ACK
or HTTP 200 alone does not establish complete publication: retain encrypted
outboxes and compare the final full manifest. Existing quick regressions run
with `cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py
recording-archive` and the backend trace-archive-batch unit family. Native
fleet/R2 timing and historical attribution remain pending the matched normal
CLI run; cached replay provides infrastructure proof only for exercised paths
and zero LIVE LLM credit.
A disconnected DELETE may still be sealing a large descendant tree. The runner
waits at most 180 seconds for that exact root/owner's database deletion fence,
preserving the last `delete_seal_observation`; provider/payment reconciliation
is authorized only once the entire tree is sealed. Missing/changed ownership
and a tree that does not seal remain INFRA. Publish durable evidence with
`python3 scripts/publish_evidence_links.py --run-json
<run.json> --agent-id <id>` before citing an FE link. Composite benchmarks
can carry multiple root UUIDs in a comma-joined
`agent_id`; publish each real root UUID separately with the same run JSON.
The publisher creates a separate evidence-only Hub projection from that
root's captured stage transcript and refuses missing or ambiguous transcripts;
it does not change the aggregate benchmark result. A Hub 503 saying the
archive index is warming for a composite root usually means only the joined
ID was indexed: retry with the real root UUID and the current publisher.
For new commits with unchanged dependency manifests, pooled snapshot
dependencies remain reusable;
`cloudbench-fetch-ref.sh` logs Git fetch, checkout and reset stage durations
so a slow cold-code bring-up can be separated from stack/worker startup.
On the 2026-09-29 fresh-code width-ten run, Git fetch took 0–1 seconds and
checkout 0–1 seconds per guest after the negotiation fix; check those stage
lines before attributing a slow stack to Git. The worker autoscaler checks
the primary's exact mounted volume size. A 20 GB pooled primary uses one
reusable snapshot of a stopped 20 GB pool volume; a 40 GB fresh primary uses
the warm snapshot. The first pool snapshot is created once, ahead of task
start, and its exact ID is cached in the git-common
`cloudbench-pools/<workspace>.ids.worker-snapshot.json` file. If Fly still
reports that snapshot as `running`, wait for the same ID to complete; do not
start another upload or resize every worker to 40 GB to work around it.

For a consecutive full-catalog no-INFRA gate, run
`scripts/run-bench stability-proof -k K --concurrency N --seed S`. It executes K
sequential random slices of N isolated ready tasks from the unified first-party
and Polar catalog. Actual `PASSED` and `FAILED` terminal batch results
advance the streak; `SKIPPED`, missing/malformed results, `INFRA_ERROR`, `ERROR`,
and `CANCELLED` fail closed. Its offline fake-provider regression runs inside the
existing deploy test path, adding no live benchmark stage, cost, or deploy wait.
For an explicitly infrastructure-only proof, preserve benchmark tasks, prompts,
models and evaluators. Require actual startup, progress, terminal evaluation and
verified teardown; do not repair task-success behavior merely to improve this
proof's scores. A task-level `FAILED` remains a valid outcome under this gate.

Browser credential preparation reads LocalStorage, IndexedDB and CacheStorage
payloads as opaque PostgreSQL text. Keep their ORM selects metadata-only and
bound the serialized CDP envelope, including JSON escaping; a row-count limit
does not bound one large origin. Decode only in the matching document after all
parts arrive, and preserve the selected user/origin/revision and cancellation
fence. `browser-origin-injection-memory` transfers a 78.6 MB synthetic origin
through real `injectUserData` and Postgres under an unchanged 1,200 MB RSS budget;
`browser-origin-payload` owns assembly, storage behavior, wire bounds and revision
isolation. Restore these payloads through one owned synthetic-origin page reused
within preparation, then close it after storage commits. Do not register large
payloads with `context.addInitScript`: Playwright retains and retransmits every
script to new pages and frames, even when its JavaScript origin guard returns.
Keep restoration additive, bypass service workers only on the owned page, and
intercept its navigation without visiting the real site. The real Chromium/CDP
`browser-origin-target-replay` blackbox checks unrelated-target wire bytes,
storage after injector disconnect, caller-page preservation and late page
acquisition after cancellation. All three suites run in the backend `/deploy` gate.
These causal tests do not prove that an earlier live OOM had the same allocation
source; retain its evidence and verify fresh fleet outcomes separately.
A fitting origin payload completes in its data packet; avoid a separate empty
CDP acknowledgment. Keep the last packet bounded and withhold its completion
marker until the opaque SQL read transaction succeeds. Recheck the combined
wire envelope and retain separate completion only when it cannot fit. The same
real-CDP blackbox counts actual acknowledged payload mutations while checking
persistent storage, cancellation and unrelated targets; it remains in `/deploy`.
Bound packet-sizing work as well as transmitted bytes: do not repeatedly
serialize the entire unsent SQL chunk. The same memory blackbox measures encoded
bytes against delivered bytes while preserving its content hash and RSS budget.
`Origin payload transfer timing` reports numeric encoding/CDP wait totals and an
in-flight wait on cancellation without logging origin payloads. Compare those
with the same request's SQL timings before attributing a live timeout.
Credential CDP connection and browser-state injection default to 18 seconds;
`BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS` and `BROWSER_STATE_INJECTION_TIMEOUT_MS`
override those infrastructure budgets. Origin-payload SQL uses the configured
state budget too. This approved 20% headroom does not change benchmark execution
backstops, the fleet E2E cutoff, or evidence and teardown requirements.

Browser-action message saves carry a unique `browser.save_action_message` span
through the existing HTTP tracing headers. Join its worker error to the backend
request's `parent_span_id`; an enclosing browser activity alone can contain many
saves. A five-second save acknowledgment timeout during execution is distinct
from teardown. Verify durable message identity separately: a row appearing later
does not erase the failed acknowledgment. The browser-agent blackbox covers
per-call correlation, failure attribution, context restoration and payload-free
logs while retaining the existing timeout and retry behavior.

Run durable publication with the agents environment, for example
`agents/venv/bin/python scripts/publish_evidence_links.py --run-json <run.json> --agent-id <id>`.
Transcript verification must follow both root-message ownership and the actual
renderer: user/attachment text is literal; assistant Thoughts use Markdown.
Use the existing CommonMark parser with GFM table/strikethrough rules for snippets, preserving literal
delimiter runs and line boundaries. A fresh-browser timeout can mean the verifier
expected text the UI never renders; capture that exact predicate before changing
timeouts. The existing publisher browser-validation blackbox owns these cases.

PR #1299's completed original acceptance required **ten consecutive slices
of ten distinct daily/Polar benchmarks**. The current five consecutive width-fifty
LIVE runs follow Eval Suite's Current width-fifty LIVE acceptance instructions:
1,200 seconds per task and 3,600 seconds from the first uncached image invocation
through original evidence and exact resource closure. The following 1,800-second
deadline describes the completed width-ten campaign. Each benchmark must execute meaningful
real provider work, reach terminal `PASSED` or `FAILED`, and release its exact
owned resources within one 1,800-second allocation-to-finish deadline. Normally
expect more than three LLM calls when sensible; chat, early terminal results and
execution-window failures may need fewer. Do not force extra calls or count
cached replay, queued requests or a Rose start event alone as provider execution.
Inspect the actual terminal trajectory and correlated provider evidence once.
An ordinary task failure or execution-window failure is acceptable. Recovered
LLM, browser, save and persistence errors, intermediate timings and the 20-minute
target are warnings. Missing meaningful execution, a missing terminal outcome,
an E2E cutoff breach or lingering owned resources prevent credit. Retain original
run artifacts and cleanup evidence; durable FE/LLM publication is best effort
after execution and resource release, and does not block the next slice.
Publishers must retire before final cleanup. Keep the normal 7,200-second
backstop and the requested temporary 300-second execution backstop unchanged.
These requirements do not change benchmark grading or deploy qualification.
Owned cloud finalization keeps archive/readiness/publication failures in
`cloud_cleanup_evidence.warnings` and preserves the evaluator's terminal verdict.
A lost pause acknowledgment can likewise recover through the later exact
sealed-tree, provider and payment proof. Missing execution results or ownership,
unsealed trees and unresolved external resources remain hard cleanup failures.
The existing benchmark deploy domain covers warning-only completion, late logs,
missing results and the provider/payment/ownership failure controls.
Benchmark request identity is scoped per task; exact resource cleanup temporarily
overrides it with the persisted root owner. Preserve that precedence and restore
both scopes on cancellation. The existing cleanup and benchmark identity tests
cover concurrent siblings, preflight failures and callback/result contracts.
Benchmark task PASS/FAIL is emitted as soon as evaluation completes, before
normal agent/phone teardown. The owned fleet aggregator publishes changes,
verifies the matching live Hub response, then acknowledges the exact guest
outcome packet. The guest waits up to sixty seconds before cleanup; unavailable
publication is a warning and cancellation still releases resources. The frontend
polls every five seconds; the existing upload transport bound still applies. Early result visibility does not prove
recording availability or resource release. The compact automatic deploy control
is `python3 scripts/tests/benchmark-live-results.test.py`; it covers publication,
agent/phone cleanup ordering, and pending worker admission with real serialized
capacity controls. Unknown provider inventory admits no worker and retries on
the existing autoscaler poll. Completed tasks stop future worker allocation;
late inert clones preserve exact prelaunch evidence and are reaped. Launched
workers still require runtime evidence. A redundant native update of an inert
clone can consume an organization slot; use the verified inert creation CMD and
clear BOOT in the explicit wrapper. The compact deploy gate owns these controls.
The live publisher starts before allocation, carries startup and release phases,
and keeps the Hub live through teardown. Final publication occurs after resource
release. Hub transport keeps complete messages/tree and task/evidence metadata;
diagnostic worker/backend/realtime logs stay in the original local archive.
Never solve the decoded HTTP payload limit by raising it or truncating transcripts.
The dispatch timeline treats evaluated outcomes as finished execution, not active
work. Guest outcome ACKs must match canonical packet bytes and an integer version;
Python's numeric equality is insufficient. An auxiliary final Hub upload warning
preserves the canonical outcome and teardown exit code; durable evidence still
needs independent confirmation before fleet acceptance. The same compact deploy
control covers these boundaries, and the frontend renderer covers terminal display.
For the earlier explicitly authorized follow-up 50-task run only, add five minutes:
use `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=600` and `--timeout 600` (temporary).
The normal 7,200-second backstop and independent 1,800-second allocation cutoff
remain unchanged. Do not run paid smoke gates concurrently with a latency proof.

The live-query verifier retains strict diagnostic findings for owned terminal
`rose.complete.failed` and browser-state injection failures. Use its existing
`--diagnostics-only` mode for this campaign: a recovered error remains visible
without rejecting a genuinely executed, terminal and cleaned-up benchmark.
The separate `infra_errors` receipt contains event hashes, never response bodies.
The benchmark blackbox gate runs the fast completed-query regressions: distinct
requests sharing a span, duplicate trace views, missing or conflicting terminal
evidence, and cache-only output. Keep these behavioral assertions in the existing
gate; they require no model calls or separate verification stage.
An ordinary task verdict cannot hide a model-request stall. Its `failed_queries`
receipt identifies the exact request and route; foreign trees and post-execution
cleanup failures cannot be borrowed into this progress check. A rejected primary
route that recovers to a completed call is distinct from a terminal request
failure. Inspect both rather than treating every fallback as an infrastructure
failure or counting partial output as a completion.
For latency investigations, `stream.profile.await_s` includes the terminal
provider wait on errors, cancellation and EOF. Do not infer wire silence from
normalized chunk counts alone: SSE parsers can buffer tool argument deltas until
the tool finishes. Compare raw receipt times with normalized progress when
reconstructing an idle failure, preserving the original request and budgets.
Rose's existing idle guard also recognizes nonempty buffered tool-argument
fragments; these preserve the normal complete-tool output and never count as
successful queries. HTTP attempts reset TTFT independently. Use the failure
receipt's `buffered_tool_argument_fragments` and `last_tool_argument_s` to
distinguish buffered progress from genuine silence; comments/usage do not
extend these bounds. The fixed 590-second model-request deadline still applies.
Cerebras quota rejection now records a credential/model cooldown before the
next request uses the existing pool waterfall. Provider retry/reset evidence
controls expiry; missing timing uses 60 seconds. Shared backend state and local
cached reads avoid repeated probes without retries or model-budget changes.
Health RPCs have a two-second whole-operation bound and fail open for routing;
backend-isolated fleets still have independent cooldown domains. A recovered
quota rejection is not a terminal model failure or a completed query by itself.
With `--min-successful-llm`, sampling excludes catalog tasks whose declared
checks require `zero_live_spend` and rejects an explicit pool containing one
before provisioning. Cached-only mass-agent/demo replays cannot establish live
model progress; keep their normal cache and evaluator contracts intact. They
remain available for ordinary benchmark and infrastructure-probe runs without
that live-query requirement. Choose compatible smoke tasks for the proof.
Shared asynchronous cache requests have one HTTP owner. A cancelled waiter must
not cancel the shared result; owner cancellation must release the exact entry so
live followers can retry. Keep actual request failures typed and visible, and
account for settled shared exceptions. Existing Fast Cache regressions cover
waiter/owner cancellation and HTTP-error propagation without longer deadlines.
The existing `BENCHMARK_FAST_MODE_CACHE` A/B setting controls the Fast Mode provider-speed button;
it does not disable DEMO cache replay. Catalog `fast_cache: on/off` declarations
still win at request construction, and simulation forces provider Fast Mode off.
Live-query selection also excludes goals admitted by the runtime's DEMO replay
policy, including an identity-bound creator child without a DEMO tag or
zero-spend evaluator. Those runs cannot certify live progress even with the
button off. Never count cached outputs or add synthetic calls to qualify them.
Keep dependency snapshot reuse enabled; provider speed, model-response replay
and dependency caching are separate controls.
For the current accelerated validation, the user explicitly requested a
temporary 300-second benchmark execution limit and a separate 30-minute hard
cutoff for any bench that has not finished its full end-to-end lifecycle. Apply
the five-minute limit through `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300` and
`--timeout 300` on the proof command; enforce the 30-minute ceiling through an
independent monitor of `bench-e2e.started-epoch`/`finished-epoch`. A cutoff is
an interrupted diagnostic: cancel the exact proof owner, recover and audit its
resources, and grant no slice credit. Distinguish the allocation cutoff from a
normal execution-window `FAILED`, which can qualify after verified cleanup. Restore
the 7,200-second backstop after this requested validation.
After each valid slice, report the whole slice's wall-clock time and every
bench's individual wall-clock time (including startup, evidence collection and
teardown, alongside the task-execution duration where available). Inspect task
trajectories and exact cleanup receipts before advancing. Include compatible
smoke-tagged tasks where the selected suites provide them; never add synthetic
calls to a chat smoke. The user waived speedup reviews. Report actual 20-minute
E2E spikes as warnings and retain latency diagnostics without adding acceptance
gates or speculative optimization.
The independent 30-minute cancellation cutoff remains unchanged. An INFRA failure
or runtime/runner change that invalidates earlier results restarts the ten-slice
streak on a clean commit. The October 1 user clarification preserves credit for
documentation and test-only changes when the exercised runtime and proof inputs
are verified unchanged; record that comparison instead of resetting on SHA alone.
Freeze the campaign candidate and avoid opportunistic main updates. An observation
timeout requires exact-owner reconciliation, not an automatic restart. Forensic
recovery never retroactively grants credit.
If cloud collection reports `driver exited without cleanup acknowledgement`,
inspect the guest's original finalization error first. For `archive: TimeoutError`,
check the last `browser_archive_observation` by exact browser task: a recording
attachment and a terminal message are separate requirements. A completed browser
activity may still have its manager parked on write approval. PAUSE must end that
deferred resume, join its owned approval wait and persist the same-task terminal;
it must not invent a user rejection or start another activity after PAUSE. The
existing browser blackbox verifies this through actual message serialization and
the archive predicate, alongside successful resume, cancellation, handoff and
foreign-identity controls. Keep this compact owning case in the normal gate;
neither a longer archive timeout nor a fabricated cleanup acknowledgement fixes
the producer boundary.
Local benchmark launchers require normal trace capture: use
`TRACE_ARCHIVE_ENABLED=1` for `run-bench --local` and predeploy smoke. The CLI
rejects explicit disabled values before allocating a stack; semantic latency
stacks may still disable capture. Do not copy their environment into benchmarks.
To interrupt a local benchmark, cancel its owning benchmark launcher first and
wait for the benchmark cleanup receipt before stopping its dependent stack.
`local-benchmark-owner.json` names the benchmark child; `local-stack-owner.json`
names the service stack. Verify native process birth before signaling either.
For the completed original campaign, draw 100 distinct tasks from the canonical `daily`
and `polar-bench` selectors. Reset the task pool whenever the streak restarts
at slice zero; exclude successful names only within that active campaign.
The daily selector has no compatible smoke tags in the current eligible pool,
so do not add smoke tags or borrow tasks from another suite to manufacture
coverage. The private campaign plan records the seed and each ten-task slice.
The 2026-09-29 smoke-inclusive candidate `20260929-161610-10375` earned no
credit: the planner benchmark root reported clean interrupt handling but its
stack cleanup failed, leaving a worker alive and no guest ACK. The recovery
path formerly mistook that narrower runner receipt for whole-guest cleanup and
waited 600 seconds for runtime evidence after the guest reported terminal HTTP 500. See `docs/rca/cases/2026-09-29-runner-receipt-accepted-before-stack-cleanup.md`.
Never release its exact pool claims or start another slice until stale-owner
recovery verifies the guest and provider state. The planner pool VM also showed
roughly 40–50% CPU pressure during its slow boot versus about 0–1% on comparable
active VMs; inspect or replace that host-bound pool member before counting a
fresh streak.

Fly's legacy `cloudbench-warm` donor has a 40 GB volume, although current
`run-bench-cloud --setup` defaults to 20 GB. Snapshot clones inherit the donor
volume's size, and a 40 GB snapshot cannot be restored into a smaller volume.
This is provisioned capacity, not a 40 GB upload by the controller. The stopped
20 GB capability pool is claimed and returned across sequential slices.
Cloud images install pgvector through `scripts/cloudbench-install-pgvector.sh`.
It builds the pinned, checksum-verified release against headers matching the
installed PostgreSQL version; it preserves that server and checks both the
extension control file and shared library. A newer distro/PGDG binary can require
an incompatible JIT package even when the PostgreSQL major version matches.
Run `fly auth docker` immediately before a long-build image's `docker push`:
expired registry credentials can report `app repository not found`. Keep auth
output private. Updating the image does not refresh dependencies on persistent
volumes; use the owned warm donor's normal `--refresh-deps` path afterward.
Task-free infra probes use the default 4 GB primary shape so they can borrow
that pool even when sampled names are browser/payment tasks; they also skip
the payment-only bundled frontend build and launch one worker, since no sampled
task executes. Each real isolated cloudbench guest also defaults to one Temporal
worker process: a single worker has ample workflow slots for one benchmark,
whereas eight workers per guest at width ten exhausted the shared namespace's
poll budget and delayed stack health by several minutes in the 2026-09-29
diagnostic. This guest-only default does not change the eight-worker deploy
stress test. Real browser and payment benches retain their 8 GB shape and
frontend contract. A fresh large-primary clone still inherits the legacy
donor's 40 GB volume until a verified 20 GB donor replaces it. Keep using the
existing stopped pool across slices; Fly can transiently return a valid empty
snapshot list even while completed donor snapshots exist, so the controller
retries the listing before treating the donor as unprovisioned. For the counted
mixed-shape fleet proof, set `CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1`: an 8 GB
browser/payment primary claims a stopped 20 GB pool volume and its boot-config
update resizes compute to the required shape before guest start. Retain an
already-admitted 8 GB shape across slices and claim a matching stopped Machine
first: shrinking every pool member to 4 GB forced another host-local CPU
reservation on the next browser run, which failed with Fly's "insufficient CPUs
available on the current host" even though another stopped member could be
resized. Verify any actual resize before start. This avoids a per-slice 40 GB
legacy-donor restore without changing benchmark execution or evaluation.
An inert provider probe on 2026-09-29 resized one stopped pool Machine 4 GB →
8 GB → 4 GB with the same volume, env, mounts and command. Keep
`waiting_for_detach` volumes in the exact-owner ledger: Fly has accepted
deletion but has not confirmed a terminal state. If a fleet is canceled before
its boot-config barrier releases, only the exact stopped-Machine, unreleased
barrier and preallocated runtime-owner proof can discharge guest cleanup; the
`guest-never-started.confirmed` receipt is not a benchmark result.
For a cancellation after guest start, exact-owner recovery must obtain guest
shutdown acknowledgements and recapture the sealed runtime bundle over each
machine-pinned status proxy before returning pool members; an interrupted local
collector must never be mistaken for absent guest work.
If a failed guest cannot seal runtime evidence, preserve its original bytes
with `scripts/cloudbench-build-interrupted-pool-archive.py`, then run
`scripts/run-bench --recover-stale-owner <exact-owner-token>`. A task
owner canceled before allocation can legitimately lack a pool directory and
execution inputs; normal recovery proves empty ledgers and absence of allocation
markers recursively. Never fabricate missing inputs or guest receipts.
For a generic failed-owner archive, `_forensic/archive-verified.json` means
the complete originals are preserved: `native_release_verified=false` and
`proof_credit=0`. It admits the normal exact-owner reaper; it does not prove
resource release. Continue the same supported recovery command through its
final native provider audit and owner retirement. Do not invoke the archive
verifier directly or treat archive readiness as completion. Other forensic
receipt modes retain their existing contracts.
If recovery retains a shared central Hub with
`retained-exact-owner-transfer-required`, first prove that every controller
borrowing that exact Hub token has retired. Keep its owner file and use the
existing helper from modern Bash: source `scripts/lib/cloudbench-env.sh`, then
call `cloudbench_terminate_central_hub_owner <port> <absolute-runs-root>
<absolute-repo-root> <absolute-owner-file> 120`. The helper checks the exact
PID birth, command, endpoint and token before signaling, and writes a read-only
terminal receipt after verifying process-group absence. Retry the original
`--recover-stale-owner` command to seal the remaining claim. Preserve other
Hubs, the progress dashboard, provider inventory and the user's network settings;
never remove a claim merely because its resource observation timed out.
For a fresh task-free canary interrupted before service startup, follow
`agents/benchmarks/README.md`'s original-volume capture procedure. The validator
binds the clean checkout, native injected controls and original archive to the
exact source recipe, then requires independent review of its pre-service phase.
Its separate bootstrap receipt always grants zero benchmark credit; it does
not fabricate a provider manifest or guest cleanup acknowledgment. Current
source-equivalent clean recipes need no commit-specific validator edit.
Pre-service phase approvals belong to the invoked controller's committed
`scripts/cloudbench-prestack-source-reviews.json`, including its immutable
script snapshot; capture-local review metadata is only an instance audit.
A changed executable-source fingerprint requires independent review before a
policy entry is committed. The existing bootstrap-recovery control remains in
the normal CLI/deploy structural gate. Incomplete older captures
still fail closed, and normal recovery must verify exact native resource release.
An interrupted task
that allocated no browser session may carry a `provider-zero-manifest` plus
its exact zero-allocation query receipt; the forensic verifier checks those
against the original run/backend bytes before releasing the owner. Such an
archive is always zero proof credit, even when the benchmark itself evaluated.
The same recovery archive may contain only sealed guests when controller
collection was interrupted after their cleanup. Completeness does not turn a
failed controller into a valid slice: exact owner/hash/native-stop checks and
zero proof credit remain mandatory before releasing its claims.
An interrupted primary may have an autoscaled worker. Preserve its
`worker-runtime-evidence/<machine-id>/capture` and owner record as well: recovery
uses the same exact terminal/log-hash/provider-inventory verification as a sealed
primary. A destroyed worker's missing or mismatched capture cannot be replaced
by an empty worker ledger or by clearing audit records.
Worker evidence JSON must become visible only after complete bytes are fsynced,
without replacing an existing receipt or creating a second hard link. Use the
existing exclusive-rename publisher; an `O_EXCL` create alone exposes empty JSON.
Debug receipt failures with the original owner/stop/terminal files retained
privately. The existing `cloudbench_worker_evidence_test.py` owning gate covers
the live supervisor's publication race and immutable-owner controls; extend that
gate instead of adding another verification suite.
Autoscaled clones must be inert at creation: `machine clone --detach` still
boots immediately, so a later `machine update` cannot prevent a copied primary
driver from running. The controller uses `--override-cmd "sleep infinity"` and
the existing native inventory to reject inherited `init.exec`/`init.entrypoint`
before allocation. If a worker fails to join, inspect its preserved bootstrap
log and provider startup timestamps before retrying. After runtime completion,
settled tracked=ready capacity below desired is an explicit INFRA failure;
waiting cannot create replacement capacity. The existing benchmark blackbox
gate covers immediate clone startup and retired-worker terminal handling.
For sustained mixed or load-test validation, select dedicated primary CPUs
through the existing fleet settings, retaining catalog-specific memory:

```bash
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=performance-1x \
CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-1x \
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1 \
BENCHMARK_FAST_MODE_CACHE=false \
scripts/run-bench stability-proof -k 10 --concurrency 10 --seed <integer> \
  --exclude-file <prior-successful-names.json> --min-successful-llm 3
```

Pooled boot admission checks the requested CPU kind, count, memory and native
stopped state exactly; shared CPUs cannot satisfy a dedicated request. Dynamic
pool reuse retains admitted 8 GB shapes for either CPU kind and prefers an exact
shape before resizing. The fleet-wide default remains shared to fit larger
daily fleets' reservation budget. PR #1299's dedicated profile passed its
ten-slice infrastructure campaign and was merged and deployed. That width-ten
result does not certify larger widths; passing resource tests alone is not a
benchmark outcome.
If a stopped member cannot reserve the requested CPU on its current host,
stop before starting tasks and inspect its exact resize log. Preserve the member
and its evidence while replacing that exact unclaimed slot from an existing
verified 20 GB snapshot. A snapshot-backed clone may remain `created` until its
volume is ready and its initial config update commits; neither a stop nor a
start request from `created` proves readiness. Admit the replacement only after
an inert boot, native stop, exact CPU/memory/volume verification and durable pool
transfer. A timed-out config update may commit later: reconcile its exact native
state before repeating it or allocating another clone.

For a verified smaller donor, set `CLOUDBENCH_WARM_MACHINE_NAME` and
`CLOUDBENCH_WARM_VOLUME_NAME` for the fleet and its maintenance commands. A
nondefault machine uses its own git-common dependency/snapshot proof file, so
it cannot borrow the legacy donor's freshness claim. Copy the complete donor
data, verify it, stop the new machine before snapshotting, and pass an exact
infra canary before using it for real benchmarks. Preserve the old donor until
the replacement has proved startup and teardown.

Local execution is explicit:
`scripts/run-bench --local <task...>` or
`scripts/run-bench --local --rerun-failed latest`. The local wrapper starts an
isolated `scripts/run.sh --benchmark` stack with per-run ports, DB
container/volume name, frontend/public URL, Temporal task queue, and manifest
under `.context/benchmarks/<run-id>/`; it keeps failed agents long enough for
`agent_latency.py`, `agent_logs.py`, and `agent_cache.py`, then tears services
down. Checkpoints are local-only:
`scripts/run-bench --local <task> --checkpoint <turn_n>`; add
`--checkpoint-no-start` for a paused FE-visible checkpoint.

Use `scripts/run-bench eval` for the full eval suite. Direct
`run_benchmark.py --port N` remains the lower-level path for already-running
services or special cases. The command's selection, `-k`/`--runs`,
`--concurrency`, isolation identities, random ready-catalog slicing, terminal
batch classification, and failure propagation are exercised with fake provider
children inside existing deploy tests; keep that proof offline and `$0`, with
no separate live benchmark stage or cloud wait added to `/deploy`.

When browser recovery reports a missing CDP URL, inspect the preceding backend
configuration-search result before blaming provider allocation. A failed search
(`success: false`) must preserve its error and metadata and must never become a
selected browser. Challenge exhaustion alone can be a genuine task failure;
check candidate allocation/probe errors separately. The existing
`challenge_recovery` agent blackbox domain covers failed-search decoding,
successful winners, and preservation of the caller's malformed-winner guard.

Durable evidence publishing requires `BENCHMARK_SHARE_SECRET` to match the
deployed backend configuration and Chromium installed for the backend's declared
Playwright version. Preserve the existing key when synchronizing env files;
never print it. The publisher verifies the signed link in a fresh browser;
`--run-id <UUID>` identifies an existing Hub run when `--run-json` is unavailable.
Hub uploads use standard gzip without changing decoded transcripts or the
original size-derived timeout. For a forbidden upload, preserve validated
CF-Ray/Render/backend request IDs and compare retained server logs before
changing auth or retry policy. A 403 stays terminal; never log its raw body or
arbitrary headers. Registered benchmark blackboxes cover lossless live/final
upload retries and safe rejection evidence. A diagnostic republish is zero credit.
On Linux, install the host libraries with the declared backend Playwright CLI
(`node back-end/node_modules/playwright/cli.js install-deps chromium`) as well as
its Chromium binary. If a direct launch reports that the browser closed, inspect
complete native stderr for missing libraries before changing launch timeouts.
If fresh-browser transcript verification times out, compare expected snippets
with the root MessageList scope: nested browser `subAgentId` messages belong in
their browser panel, while root replies, exploration progress and code lifecycle
anchors remain visible. Keep terminal/recording checks intact. The shared-agent
GET retries one direct transport timeout with the same per-attempt limit; HTTP,
JSON and evidence failures fail closed. Never apply that read-only retry policy
to an ambiguous message POST timeout. The existing
`scripts/tests/publish_evidence_links_browser_validation.test.sh` covers scope,
native socket timeouts and rejection controls without a new test stage.

- Every time a benchmark task is run, include the valid FE link to view the run (for example, `http://localhost:5050/?agent-id=ac267c32-470f-41da-8343-091b8965c410`) and verify it actually displays the agent.

## Cursor Cloud / Linux dev environment

Cloud agents run on Linux. **Read this whole file first**, and use the repo's own
skills by default — the `.claude/commands/*` slash-commands (`/deploy`, `/RCA`,
`/benchmark`, etc.) and the `docs/` guides they point to (e.g. `/RCA` →
`docs/root-cause-analysis.md`, testing → `docs/testing.md`). These are the source
of truth; do not duplicate them into other files.

- **Setup / refresh (run at the START of every cloud session):** `bash scripts/cloud-init.sh`.
  It is idempotent and reuses the battle-tested Fly-cloudbench pattern
  (`scripts/cloudbench-entrypoint.sh`): (1) decode the injected
  `AGENTS_ENV_B64` / `BACKEND_ENV_B64` secrets into `agents/.env` / `back-end/.env`
  (whole-file base64, optional `*_ENV_SHA256` check — no per-key drift), (2) run
  `scripts/cloud-build.sh` (root `npm install` + `prisma generate` + `agents/venv`
  - local Postgres), and (3) **seed the local DB from prod** via
    `back-end/scripts/seed-local.ts` so a cloud agent never starts against an empty
    database. Missing secrets / a failed seed WARN and continue (never abort). The
    seed is skipped when the dev user already exists.
    `scripts/cloud-build.sh` alone remains the minimal deps-only provisioner if you
    do not need `.env`/data materialized.
- **Database:** Docker is typically unavailable on the Cloud VM, so the stack uses
  **system PostgreSQL** at `localhost:5432` (`postgres`/`postgres`, db `victoria`);
  `scripts/run.sh` and the blackbox runner auto-fall back to it. Start it with
  `sudo service postgresql start` if needed.
- **Toolchain:** `agents/venv` uses Python 3.11 (the pinned version; system
  `python3` may be newer). A few suites also need `ruby` + `rsync` installed
  (deploy-gate + cloudbench tests) — otherwise you'll see `ruby: command not
found` / `rsync: command not found`.
- **Cloud fleet controller:** Follow the long cloud fleet proof guidance in
  `docs/testing.md` for the dedicated-CPU controller requirement, exact-owner
  recovery, and warm snapshot reuse before starting width-10 validation.
- **Skip `mac-app` on Cloud/Linux — tests AND `dev`.** It is macOS-only (Electron
  - `darwin`-only native deps such as `node-mac-contacts`); its `npm install`,
    `npm run dev`, and blackbox suite cannot run on Linux. `run.sh` and the husky
    pre-commit hook already skip it on non-Darwin. Do mac-app work on macOS only.
- **Running services directly (no ngrok/secrets):** backend
  `cd back-end && PORT=<N> npx tsx watch src/bootstrap.ts`; frontend
  `cd front-end && npx vite --port <N+1>`. In dev the frontend infers the backend
  as `frontendPort - 1` (see `front-end/src/lib/backendUrl.ts`) unless
  `VITE_BACKEND_API_URL` is non-default — matching `run.sh` (backend=base,
  frontend=base+1). The backend `ALLOWED_ORIGINS` must include the frontend origin.
- **Injected env vars override `.env` (important).** Node `dotenv.config()` and
  Python `load_dotenv(override=False)` never override an already-set variable, so
  anything injected by the Cloud environment/Secrets wins over `.env`.
  `TEMPORAL_TASK_QUEUE` is injected pointing at a shared queue — always `export
TEMPORAL_TASK_QUEUE=navi-agent-tasks-<unique>` for BOTH backend and worker so a
  local worker never consumes other runs' workflows (mirrors `run.sh`'s
  per-workspace queue). `BROWSER_PROVIDER` must be `kernel`, `steel`, or
  `browser-use` (which requires `BROWSER_USE_API_KEY` and
  `BROWSER_AGENT_BROWSER_USE_ENABLED=true` on the backend). The rollout flag
  defaults off and prevents new Browser Use sessions, challenge recovery, and
  proxy hopping into Browser Use; set it false to route new work to Kernel even
  if Browser Use was configured as the default provider.
  Browser Use Cloud has not passed the live WebAuthn assertion test
  (`browser-passkey-provider`); keep the flag off for passkey-dependent work
  until that provider passes. Its CAPTCHA solver also left a live reCAPTCHA
  image grid unresolved; hand unresolved challenges to the live-view user.
  When something is misconfigured despite a correct `.env`, check for an
  injected env var of the same name first.
- **Local backend tests on Fly hosts:** launch the test child with
  `env -u FLY_APP_NAME` before TypeScript imports. Any defined value, including an
  empty string, selects production mode and suppresses the local LLM dumps that
  the Rose and stream-contract blackboxes verify. Preserve the parent controller
  environment and fleet runtime identity. The existing capture assertions remain
  mandatory; a focused green replay does not replace complete coverage.
- **ngrok (public tunnels / AgentCard):** Cursor Secrets must include both
  `NGROK_AUTHTOKEN` and `NGROK_API_KEY`. `NGROK_API_KEY` is the **secret token**
  (`FIRSTPART_SECONDPART` from dashboard.ngrok.com/api-keys → Reveal), **not** the
  key ID (`ak_…`). An ID fails reserved-domain calls (`ERR_NGROK_208` / 403) and
  tears down `scripts/run.sh`. `cloud-init.sh` syncs both into `agents/.env` +
  `back-end/.env` and configures the local ngrok authtoken. Prefer
  `HOME=/home/ubuntu` so ngrok finds `~/.config/ngrok/ngrok.yml`. On Cloud VMs
  where Docker overlay mounts fail, set `ROSE_USE_SYSTEM_PG=true`.
- **Tests needing funded/live accounts** (RCA Step 4: third-party/config — surface,
  don't mask): the Codex E2B backend blackbox domain and all **smoke benchmarks**
  need OpenAI account credits (+ OpenRouter access to the `rose-1-ultra` waterfall
  models); `admin-health` needs Amplitude + admin-Stripe creds; `agentcard` needs
  `AGENTCARD_PUBLIC_URL`.
  The agents `benchmark` blackbox domain also contains real Blue Bottle LLM
  judge replays. Full agents coverage needs the complete authoritative env and
  working outbound access; HTTP capture does not replace live responses with
  mocks. Its existing runner control checks two bounded native lanes, ordered
  result reporting, cancellation drain, and exited-parent descendant cleanup.
  The terminal-evidence fixtures share one 60-second deadline across two isolated
  pytest groups; do not raise that limit or omit targets to mask serial waits.
  On Andy's Mac, run that full suite natively when an isolated Linux
  container lacks those prerequisites, and retain Linux checks for the cloud
  controller and affected platform-specific regressions. In particular, run
  `bash scripts/tests/cloudbench-multi-workstream.test.sh` on Linux at the
  reviewed source: its fake guest executes the real Linux worker subreaper.
  Darwin rejection tests do not substitute for that mandatory lifecycle gate.
  Its permanent `cloudbench-fake-volume-contract.test.py` runs the actual fake
  provider writers through real snapshot admission; keep positive volume sizes
  consistent with their Machine mounts before exercising ownership scenarios.
  Activate the agents venv and prepend the installed Node 22 bin directory when
  launching this gate through Machine exec; its default PATH can select Node 20,
  which cannot execute the hermetic TypeScript seed fixture.
  Keep Linux `TMPDIR`
  outside the checkout (for example `/var/tmp`): production archive guards
  intentionally redirect paths under the repository.

## Eval Suite

**Current width-fifty LIVE acceptance:** the original hundred-task campaign is
complete. The new goal is five consecutive runs of fifty distinct, randomly
selected eligible DAILY tasks per run. Keep the original completed campaign and
the cached mass-demo diagnostics separate; neither supplies this new streak.
Each run gets a temporary 1,200-second execution window per task and a hard
3,600-second whole-run budget from the start of its uncached image build through
final durable publication and verified release of every owned resource. The old
300/600-second temporary task settings, 1,800-second allocation budget and cached
diagnostic's 1,200-second allocation-to-release guard do not apply to this goal.
Normal defaults, task contents, evaluators and the provider waterfall stay intact.

A fresh CLI runner reads this file and uses the ordinary entrypoint. Make a
minimal benign comment change in `agents/benchmarks/__init__.py` in its own
checkout for each trial, record the resulting fetchable immutable ref, and build
from that same checkout. This marker changes neither executable behavior nor the
39 bootstrap/79 dependency inputs. Preserve any already-running control's source.
Use the supported uncached image build and exact-image activation for every trial:

```bash
trial_dir=".context/daily-live50/$(date -u +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$trial_dir"
date -u +%s > "$trial_dir/image-start.epoch"
trial_ref=$(git rev-parse HEAD)
scripts/run-bench image-build --builder depot --no-cache --build-context "$PWD" --out-dir "$trial_dir/image-build"
trial_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_ref"])' "$trial_dir/image-build/cloudbench-image-build.json")
scripts/run-bench image-activate "$trial_image" --ref "$trial_ref" --out-dir "$trial_dir/image-activation"
```

Retain source/build receipts and verify the actual guest image digest. Generic
source-only snapshot reuse is still normal outside this explicitly requested
fresh-image campaign. Resolve the canonical DAILY selector, intersect it with
the existing Linux/cloud-root and LIVE-eligible catalog pool, then draw fifty
names without replacement using a recorded random seed. The existing
`scripts/fleet_infra_sample.py:eligible_pool` supports those eligibility checks;
its `minimum_successful_llm=3` filters intentionally zero-LIVE/replay tasks and
does not require artificial model calls. Retain the concrete name list privately.
Sample anew for each run; distinctness is required within each fifty-task run.
Pass all fifty concrete names together to one ordinary fleet, without `-k` or
`--concurrency`; the sequential proof wrapper's width-32 cap is unrelated.

Inspect native provider inventory, controller CPU/memory/disk and normal
admission before launch. Where this load requires it, use the command-scoped
dedicated-primary profile below while preserving catalog memory and the ordinary
worker profile. Ceiling 138 is a ceiling, not a capacity promise; keep native
CPU, worker, disk and organization admission active. LIVE autoscaling remains
the ordinary maximum 15. The cached mass-demo maximum 2 must not leak into LIVE.

```bash
# tasks[] contains the retained fifty distinct eligible DAILY names.
CLOUDBENCH_APP_MACHINE_CEILING=138 \
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=performance-1x \
CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-1x \
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1 \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200 \
  scripts/run-bench "${tasks[@]}" --ref "$trial_ref" --wait --timeout 1200 --autoscale-max 15
```

Poll the exact monitoring command printed by this launch every thirty seconds
through terminal publication and native release. Keep all fifty rows in one
group; queued/startup rows need the original run timestamp, and genuine evaluated
PASS/FAIL appears before teardown. Follow actual controller status even if a card
or observation is stale. Retry transient observations with the original owner;
do not restart a healthy run or reject microscopic intermediate timings. Stage
handoffs must remain usable for their consumer. A rejected native start request
is a warning while the existing current-run guest log and live data-plane proxy
prove that the configured guest booted; a foreign, dead or unreadable guest still
fails startup. A finished child without a benchmark result publishes an explicit
infrastructure error in its original group immediately, without inventing an
evaluation or agent archive. The existing compact deploy suite covers both
startup admission and terminal placeholder publication. An early primary retirement
receipt covers only that exact sealed scope; collector completion alone does
not prove native release. Keep the original owner running through final native
audit, and never rewrite PID birth records to force cleanup. Recovery keeps
completed task outputs as history and reconnects only current allocations; retain
the exact native retirement audit instead of deleting old outputs to match a
shrinking registry. After the original CLI exits, use a verified current CLI for
the documented exact-owner recovery while preserving its original guest source,
owner and private evidence. Recovery's local proxy lease adapter represents an
absent preferred port as numeric zero; an explicit nonempty preference retains
the allocator's validation. A real started startup rejection can retain an exact
runtime owner without local start acceptance; its supported zero-credit archive
preserves actual originals and config before native reaping. It never supplies a
task result or completed-execution seal. Artifact console commands name an
executable explicitly; use `python3 -B` instead of a shell environment-assignment
prefix to suppress bytecode during read-only capture. Freeze sensible generous stage
targets from comparable historical LIVE timings, excluding cache-assisted cold
measurements, and report observed stage p95 plus image-start-to-full-release E2E.
These fixed stage targets are generous operational targets, not measured p95
statistics or independent rejection/cancellation timers:

| Stage | Target or hard limit | Historical basis and qualification |
| --- | --- | --- |
| Uncached image build/push | 600 seconds, target | Actual uncached invocation: 301 seconds. |
| Exact-image activation | 360 seconds, target | Actual invocation: 279.179 seconds. |
| Canary/preflight through its full native release | 720 seconds, target | Current CLI-to-canary release: 504.886 seconds. |
| Fleet readiness | 900 seconds, target | Partial-run observation upper bound: 686.004 seconds; only 49 executed and one startup failed, so this is diagnostic and does not prove full-fifty readiness. |
| Task execution | 1,200 seconds per task, hard | Temporary command-scoped execution window. |
| Evidence and full native release after the last execution | 480 seconds, target | Target pending measured current tail; evidence publication also overlaps execution. |
| Whole image-start-to-publication-and-release E2E | 3,600 seconds, hard | Original per-trial clock, including gaps, waits and teardown. |

Stage targets are not additive entitlements: their sum exceeds one hour, and
parallel/overlapping work must still fit the hard whole-run limit. Report actual
stage p95 when comparable task observations support it; do not label a single
historical invocation or target as p95. Warn and diagnose target overruns while a
usable stage continues; never cancel on a per-poll or internal micro-budget.

Retain unknown timings as unknown. Diagnose parallelism-related LLM latency and
errors from the existing provider evidence; paid deploy smoke or other paid
verification must not overlap an accepted LIVE latency measurement window.

An ordinary task FAIL, including a genuine execution-window FAIL, is acceptable
when it actually executed and has its unchanged terminal evaluation, durable
evidence and exact cleanup. Normally expect more than three real LLM calls when
sensible; early/chat outcomes can use fewer. Use
`scripts/verify_successful_llm_queries.py --diagnostics-only`; never force calls,
change prompts, seed replay or substitute cached acceptance. Unexecuted tasks,
missing terminals/evidence, incorrect FE presentation, resource leaks, an actual
parallelism-caused issue or the one-hour breach fail the run. Preserve every
original outcome and finish exact cleanup. At a hard cutoff or catastrophe,
verify native birth and stop only the exact owning controller through normal
cleanup; interrupted/recovered runs get no retroactive credit. Fix a proven
cause, then continue the requested five-run streak. Reset prior credit only if
a runtime fix invalidates its exercised evidence; doc/test/benign-comment changes
alone do not reset a qualified streak. Do not restart the completed original hundred.

**Cloud startup reuse:** use `scripts/run-bench <task...> --wait` normally. The
CLI reuses completed dependency snapshots across fresh checkouts and synchronizes
the requested code after boot. Dependency hashes, the donor Machine/volume, and
the exact completed snapshot are checked before reuse. A changed dependency set
refreshes once centrally; it is not installed independently on every task box.
Cache metadata publication failures warn and retain the existing verified local
receipt rather than reject an otherwise usable run. Publication refreshes the
selected Fly session through `flyctl auth token --json --quiet`; do not copy its
short-lived output into env files. A raw env token returning HTTP 403 while the
same selected session works through `flyctl` indicates stale session discharges,
not a reason to rotate keys or rebuild the image. Use `scripts/run-bench
--help` for current flags. For a per-run twenty-minute task execution window,
set `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200` and pass `--timeout 1200`.
The CLI flag alone sets the orchestration budget; the normal timeout remains unchanged.

For an explicitly requested cold-image measurement, use the same CLI:
`scripts/run-bench image-build --builder depot --no-cache --build-context <checkout> --out-dir <private-output>`.
The selected checkout supplies both `Dockerfile.cloudbench-warm` and
`fly.cloudbench-warm.toml`. The private receipt records its pre-launch HEAD,
dirty status, recipe/config hashes and elapsed build/push time; those inputs
are provenance, not artifact-equivalence proof. The shared image installer joins
the unchanged npm/Prisma and Python installs concurrently in the final layer,
then copies source last. Only npm download cache/logs are omitted; installed
dependencies, npm configuration and other home assets remain. Measure native
cold timing before claiming a speedup. Ordinary source-only runs still reuse
their verified dependency image and snapshots.
Build contexts exclude generated `.context` and `.llm-dumps` directories at
every depth. Runtime source, task definitions, current metrics and task selection
history remain available in the image. The normal image regression gate checks
the actual Docker archive with controlled generated-state and runtime sentinels;
do not trim runtime inputs to improve startup measurements.
`image-build` defaults to the existing Fly-integrated Depot backend; use
`--builder native` for an explicit native diagnostic. Setup consumes the exact
prebuilt receipt image through `image-activate`. Depot uses app scope, zstd level 3
and `linux/amd64`; the receipt records requested builder/scope/compression/platform.
The independent `9efb3dfa` no-cache build/push completed in 285.5 seconds in one
attempt; exact-image activation took 158.6 seconds (7 minutes 24 seconds of
combined CLI stage time, excluding the gap between commands and fleet startup).
These are measured invocations, not a guaranteed latency. Activate the exact receipt image
and verify guest digest/runtime consumption before the benchmark cohort.
A later independent instructions-only cold run measured 383 seconds for build/push
and 158 seconds for exact-image activation (9 minutes 1 second of stage work;
9 minutes 29 seconds including the handoff). Its fifty-copy campaign stopped
before execution during initial Hub registration, so those image timings do not
establish whole-fleet startup or teardown performance.
Image publication automatically caches the checksum-verified pinned Fly client
in the Git common directory. Native publishing uses child-only
`DOCKER_BUILDKIT=0` and `--wg=false` for classic Docker over HTTPS; the shared
Fly installation, PATH and benchmark runtime remain unchanged. A tiny supported
CLI control took 31.6 seconds including initial client installation and push;
that is not a full cold-image timing. Fresh worktrees need no manual download.

**Temporary cached startup diagnostic:** reuse an existing DEMO replay task;
do not add cache tags, prompts or seed fixtures to make a performance run pass.
The known recorded mass demo uses the documented dedicated-primary load-test
profile below. Catalog memory stays unchanged; native capacity at width fifty
still needs verification on each run:

```bash
CLOUDBENCH_APP_MACHINE_CEILING=138 \
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=performance-1x \
CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-1x \
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1 \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  scripts/run-bench test-mass-agent-run-0 --demo-cache \
  -k 50 --concurrency 50 --strict-barrier --autoscale-max 2 --timeout 300
```

For this requested cached diagnostic, the 300-second settings are temporary
execution controls. Independently enforce a 1,200-second deadline for each copy
from allocation through verified release of its exact owned resources. This
deadline supersedes the older 1,800-second proof budget only for this diagnostic;
normal 7,200-second defaults remain unchanged. A task verdict does not establish
resource release. On a cutoff, signal only the exact owned controller, let its
cleanup traps run, audit its resources, and grant no acceptance credit.

For an explicit cold-image measurement, activate the exact image from its build receipt before the fleet:

```bash
scripts/run-bench image-build --builder depot --no-cache --build-context <committed-checkout> --out-dir .context/image-build
benchmark_image_ref=$(python3 -c 'import json; print(json.load(open(".context/image-build/cloudbench-image-build.json"))["image_ref"])')
scripts/run-bench image-activate "$benchmark_image_ref" --ref "$(git rev-parse HEAD)" --out-dir .context/image-activation
```

`image-activate` uses the existing app environment lock and owned warm-source setup. It strictly stops the exact existing donor before environment activation, activates the published image on the donor and this workspace's stopped pool members, synchronizes the requested Git ref, and parks the donor. It sets the existing prebuilt-image selection internally, so it does not build again. Confirm guest image digests in the ensuing fleet's native inventory. Source-only branch runs normally reuse verified dependencies and need no image build or activation.

REAL tasks now use fresh primary and worker volumes by default with the verified dependency image, exact authenticated Git checkout and the same canonical isolated database fixture. SIM tasks, including `--sim-on` overrides, retain their snapshot and cached World Model assets. `--snapshot-volumes` forces the historical restored-volume path for a provider diagnostic; generic `--provision-pool` and legacy startup keep compatible snapshot storage. Source-only changes reuse the pinned image and inject current bootstrap helpers. A successful clone command precedes storage readiness: inspect its exact owned IDs and keyed volume state when preflight waits; retain the original failed receipt and let the owning CLI finish cleanup.
The first Git fetch on fresh REAL storage is shallow: it includes the complete
requested source tree and exact commit, while earlier benchmark-repository
versions are unavailable. Startup, patch replay, dependency checks and evaluators
use that requested tree. Retained checkouts keep their available history and
advance through the ordinary fetch path; a formerly fresh checkout still verifies
the next exact ref, patch and dependency manifests. Work that requires earlier
benchmark-repository history must retain the existing snapshot or pool path.
This changes neither the task's own external repositories nor its task inputs.
See `docs/rca/cases/2026-10-06-fresh-source-fetch-downloaded-unneeded-history.md`.

Cloud fleets retain the aggregate progress/final publisher before the starting
Hub write. They attempt that write once with a 120-second transport budget;
transient transport or retryable server delays warn and allow startup to continue.
Missing credentials and nonretryable client errors still stop startup. Follow the
printed monitor through terminal publication and resource release; a starting
HTTP response or a task verdict alone does not establish final acceptance.

Bootstrap preserves both hoisted and workspace-local baked dependencies and uses the installed Prisma CLI; do not repair a missing CLI by downloading a floating version. If a strict campaign's infrastructure canary fails, its waiting copies observe the same cohort failure instead of launching another canary each. A new CLI invocation creates a fresh cohort automatically. Genuine benchmark task failure is still a valid terminal outcome for an infrastructure/speed run; a preflight failure has no task execution credit. The compact deploy gate owns the dependency-layout, schema-cache and failed-cohort regressions.

Concurrent controllers reserve cleanup disk under one host/filesystem lock. A
sealed `--strict-barrier` cohort shares available capacity while preserving each
pending copy's 32 MiB cleanup minimum and 256 MiB working headroom; 512 MiB
remains the preferred reserve. Standalone controllers use the same atomic
admission, without promising capacity to future unannounced callers. Linux and
macOS use verified physical preallocation when supported, with the existing
zero-fill fallback for a genuine allocation-capability gap. Storage errors still
stop before provider mutation. No extra CLI flag is needed. On a reserve
refusal, inspect the actual filesystem free space and sealed cohort; do not
delete ownership claims or lower storage floors. The normal compact benchmark
deploy gate covers the 50-owner admission race, physical allocation, capability
fallback, exact release and process-identity interleavings.

Image installation loads the actual Vite configuration and compiles a small entry with its installed SWC, Rollup and esbuild dependencies before readiness. A missing declared native binding is repaired at the requesting package's exact installed version, without changing manifests or locks; healthy compilers need no extra install. Broken binaries, incorrect versions and unrelated configuration errors fail the build. Use the normal image CLI instead of ad hoc package upgrades. Matching fresh Linux dependency trees use a private writable overlay with metadata copy-up; unsupported kernels or mount permissions use the existing copy path. Checkout source, generated Prisma clients and activated Python remain isolated from the image donor. `CLOUDBENCH_DEPENDENCY_OVERLAY=0` selects the original copy path for a scoped diagnostic. Exact-owner recovery handles an empty cleanup join without weakening ownership checks. Preserve original failure receipts and use `--recover-stale-owner`; do not delete claims manually or stop a pre-existing shared Hub. These regressions remain in the normal compact deploy gate.

Cloud dependency overlays preserve each donor root’s owner, group and mode while
keeping their backing directories private. A matching image fingerprint and
successful compiler check do not replace dependency admission as the runtime
user. If a guest unexpectedly installs dependencies, inspect the retained startup
steps and npm error boundary before rebuilding or retrying.

The default offline controller image includes Node's matching npm/npx package.
Use `python3 scripts/tests/run-cloudbench-controller-linux.py --check-only` to
check its local package runners before the normal controller suite. An existing
verified image can be selected with `CLOUDBENCH_CONTROLLER_TEST_IMAGE`; that
override is recorded separately from qualification of the default recipe.
Run the status-service shutdown control with
`python3 scripts/tests/run-cloudbench-controller-linux.py --fixture status-service-shutdown`.
Its driver-ownership check needs Linux `/proc`; the dispatcher uses native Linux
there and the same offline exact-owner image on Mac, including verified retirement.

An accepted delete plus an exact owned-volume `pending_destroy` or `destroyed`
terminal receipt qualifies release even when Fly retains the object. Request
acceptance alone does not establish release.

Repeated concurrent cloud campaigns share one parent-owned Machines/Volumes inventory feed. Borrowers retain the same keyed generation and never stop the publisher; capacity admission and exact resource teardown checks stay native. A standalone fleet and production-only campaigns keep their existing paths.

A strict cohort with that live inventory owner performs the existing complete canonical fixture GET once before admitting controllers. Each controller verifies the private receipt against the live parent/publisher births, sealed cohort membership, committed source, schema/PG/cache token, runner code and storage scope identifiers. An invalid advertised receipt fails closed; it does not fall back to repeated downloads. Standalone fleets keep their full GET. Every guest still performs its actual fixture download, exact sidecar checks and database restore; this host receipt does not replace them.

The cohort host helper works with system Python without installing optional dotenv packages. It uses the existing startup budget, retries unavailable process observations, and drains only its owned GET session on cancellation before publishing proof. Follow the campaign's printed summary and private seed-preflight log; a slow healthy GET is not a reason to restart. The normal `campaign_inventory` deploy gate covers selector precedence, cancellation, exited-leader cleanup and late cancellation during hashing.

For this explicitly requested 50-copy cached stress run, use the command-scoped
Machine ceiling of 138 and `--autoscale-max 2`: the current 36 existing app
Machines plus 50 primaries, up to 50 optional autoscaler workers and two transient
slots. Inspect native app inventory and headroom again before a future run;
ordinary ceiling 56 cannot hold this current cohort, and ceiling 88 leaves only
two worker slots. This profile creates no idle resources and changes no default
ceiling, shared-CPU governor or production headroom. `--strict-barrier` coordinates
all surviving eligible copies in one ready cohort. Keep the original requested
50-copy count alongside `released_count` and `failed_count`; a partial release
never earns full-width credit. Controller occupancy does not prove execution overlap.
The default mass-task primary uses `shared-cpu-2x` / 4 GB; its optional worker
uses `performance-1x` / 2 GB. Fifty primaries add 100 active shared CPU units.
The unchanged governor keeps 20 of 160 shared units for production, leaving
140 for this app. Native CPU kinds/counts and live workstream reservations
must fit as well as the Machine count; the CLI rechecks both during admission.

Poll the printed campaign `summary.json` with `python3 -m json.tool` every 30
seconds, then follow each job log's exact printed fleet-monitor handle through
controller exit and owned teardown. The campaign directory itself is not a
fleet-monitor handle; task PASS/FAIL is available before cleanup finishes.
Foreground campaigns may print no `--controller-status` marker; use only the
actual printed handle and read each copy's controller exit separately from
`summary.json` → `jobs[].controller_exit_code`, keyed by `job_id`. The monitor's
null controller fields alone do not establish liveness or completion.
Lifecycle clocks are `<fleet-run>/<task-name>/bench-e2e.started-epoch` and
`bench-e2e.finished-epoch`. The start precedes provisioning and is conservative.
Use the earliest retained fresh native Machine/volume `created_at` for newly
allocated exact resources; pooled allocation needs an immutable exact original
claim receipt. Never use inode ctime, a pooled Machine's historical creation time,
or first observation to start/reset the 1,200-second budget. Without an original
allocation clock, qualify the original start as a conservative operator budget;
on cutoff use `conservative-provisioning-operator-budget` and
`deadline_breached=false`. A native breach needs genuine original allocation
evidence showing over 1,200 seconds without full verified release. Never
substitute the 7,200-second execution default. Release follows complete
primary/worker/claim verification; `pool-primary.returned-epoch` is only the
earlier borrowed-primary return. The immutable audit's
`provider-teardown-verified.epoch` is the producer clock, bound to the same
owner/run by `source-audit`; legacy clockless audits keep their post-verification
fallback. The run's `teardown-ownership.path` identifies its
exact audit/token; while live, capture `pid` and `pid_start` from
`<git-common>/cloudbench-fleet-ownership/<token>/meta`. Normal cleanup removes
that active claim, so retain the captured identity and verify native process
birth before any exact-owner signal. Audit retention is separate from liveness.

Each CLI campaign is shown as one group in the benchmark viewer. Every scheduled
copy has a distinct member row and keeps its own run/agent links; PASS/FAIL
appears as soon as that child publishes, before teardown. Controller exit
without a task result remains an infrastructure/cancellation status, and never
claims resource release. Group timings use the original campaign clock, not a
later recovery upload. The ordinary deploy tests cover grouping, early verdicts,
child acknowledgments, paging and complete task history.

This requests 50 independent one-task fleet controllers. Each unchanged mass
task spawns 50 first-level general-purpose children: 2,500 across the campaign;
its existing explore allowance remains unchanged. It is not 50 distinct tasks.
For repeated campaigns, `--strict-barrier` holds each bounded cohort until all
surviving eligible copies finish normal stack and autoscaler readiness, then
releases their existing start barriers together. An ordinary terminal member
failure stays failed while healthy peers and later cohorts continue. Preserve
the original requested count and report actual released and failed membership;
partial release never earns full-width credit. Shared publisher or parent loss,
invalid readiness ownership or release membership, and explicit cancellation
retain owned abort handling. Ordinary non-strict campaigns retain sliding scheduling. Active controller count
alone is not execution overlap; inspect actual task start/terminal intervals.
`--demo-cache` keeps task-agent cache reads read-only and blocks their live
fallback on cache misses or unresolved context. The separate benchmark harness
retains genuine evaluation; declared LLM judges may still call providers and
incur cost. Existing cold-terminal passthrough is not a recorded cache hit.
Every cached diagnostic earns zero LIVE acceptance credit. Normal timeout,
provider Fast Mode, task, evaluator and cleanup contracts remain unchanged.
Compact CLI, replay-hit/miss, scope and pooled-handoff controls run in the
existing `benchmark-live-results.test.py` deploy gate; this large diagnostic
is only for an explicit user request.
Both boot and legacy SSH handoff clear replay-only state before ordinary runs.
External evidence requests, including redirects from loopback, follow the
configured/default proxy route; exact loopback requests stay local. The existing
demo-handoff, publisher-browser and Claude-session dual-write quick tests own
these boundaries in the normal deploy gates.

**Monitor every cloud launch:** the detached launcher prints the private log
and exact controller exit marker. Its controller log's "Monitor this exact fleet"
section prints the complete metrics command; retain it:
`scripts/run-bench monitor <run-directory> --controller-status <exit-marker>`
(the exit marker is available with or without `--wait`). Poll every 30 seconds and inspect
terminal status on every observation, even when the progress card stops changing.
The read-only command reports exclusive stage counts, card age, task outcomes,
final lifecycle cleanup and controller exit separately, without dumping private
trajectories. An early task PASS/FAIL does not mean teardown finished. Continue
until the controller exits and exact owned resources are released. Campaign schedule
publication observes the original CLI cancellation signal and drains its exact
auxiliary uploader session. In-flight cancellation updates the original group
record, and that same owned publisher reconciles the terminal Hub projection.
An acknowledged terminal record with the exact publisher, private handoff token,
record digest and native session closure is already complete; a later signal
keeps that completed status. Keep completed child outcomes and the original E2E
clock. Unverified publication remains pending and earns no remote-completion
credit; its warning does not authorize restarting the fleet. Stale or
missing observations are warnings: reconcile exact owner liveness and private
diagnostics, never reset a run based on an observation timeout. The compact
monitor controls run in the existing `benchmark-live-results.test.py` deploy gate.
Live task rows use actual executor admission after scheduler and payment guards;
waiting copies remain queued even before any agent ID exists. Repeated names keep
separate root links, and evaluated PASS/FAIL stays visible during cleanup. Display
state never replaces lifetime ownership of every created root. The three compact
producer, early-outcome and exception/cancellation/composite-cleanup controls run
in the existing agents benchmark blackbox domain and ordinary `/deploy` Step 4g.

The startup tracker recognizes both legacy SSH and current boot-launch producer
messages. An accepted boot start displays stack booting; a provider-rejected
start does not advance it. These compact regressions run in that same gate.

To reuse already bootstrapped storage on repeated runs, prepare an explicitly sized
workspace pool with `scripts/run-bench --provision-pool N --wait`. Ordinary runs
automatically claim and return its stopped Machines. Retained volumes incur
storage cost; do not automatically retain every fresh task clone. A dependency
snapshot does not update system packages in the container image: after changing
the native image prerequisites, refresh the shared image once through the
documented `scripts/run-bench-cloud --setup` maintenance path. A missing
`vector.control` during cloud seed restore indicates an outdated PostgreSQL
image, not a task or model failure.

The compact cache regressions are in
`agents/benchmarks/cloudbench_dependency_sync_test.py` and run through the
benchmark blackbox domain and `/deploy` Step 4cb. They cover fresh-checkout reuse,
donor/volume/dependency binding, incomplete snapshots, legacy receipt migration,
and metadata-only publication without making publication a benchmark gate.
After hydration proves a matching completed donor snapshot, reuse that captured
inventory for its epoch check; a failed later read cannot invalidate the proof.
New refresh snapshots still require live epoch and exact-complete verification.

Controller token handoff to local dotenvs must use `cloudbench_upsert_env_key`:
serialize each destination's full read/update with its persistent lifetime lock,
publish changed contents atomically, and retain matching contents without a
rewrite. Preserve unrelated keys, mode 0600 and existing dotenv symlinks. The
hermetic concurrent-export controls run in
`scripts/tests/cloudbench-github-token.test.sh` under `/deploy` Step 4cb and the
cloudbench change-selected `scripts/test.sh` suite.

**`agents/benchmarks/tasks.json` is the ONE canonical benchmark catalog.** Benchmark tasks and migrated long-horizon evals live here; ordinary blackbox/vitest tests do not. Each entry carries the additive eval contract: `status`, `runner` (`agent`), `bench` (`pipeline-e2e` for Rose harness plumbing vs. `rose-bench` for harness-independent capability), `description`, `environment` (mode/db_fixtures/base_images/services/secrets/live_targets/context_notes), `evaluators[]` (`static_check` | `single_turn_llm_judge` | `agentic_llm_judge`), and `source` (provenance pointers). Validated by `agents/benchmarks/long_horizon.py:validate_catalog()`. Idea kernels that haven't become evals yet live in `agents/benchmarks/long_horizon_ideas.json`.

**Pre-Deploy bench selection (auto-attach):** `/deploy` does **not** run the full daily suite. `agents/benchmarks/select_predeploy_benches.py` builds a bounded set every deploy:

1. **Floor (existing smoke)** — every `smoke`-tagged harness task always runs (no history gate)
2. **History gate (added canaries only)** — floor canaries + path extras are eligible only when their **last 3 eligibility attempts** in `agents/benchmarks/history/task_attempts.jsonl` all passed; otherwise skipped (`SKIPPED (need last 3 historic passes)`). New/flaky canaries stay off `/deploy` until they earn that streak on the daily path. Predeploy / active-worktree runs set `counts_for_deploy_eligibility=false` so they cannot invalidate a canary after it is assigned.
3. **Floor canaries** — one history-qualified canary each for `payment`, `grep`, `sms`, `browser_stateful` (uncovered categories are reported)
4. **Path extras** — more category depth when the git diff touches matching paths (history-qualified only)
5. **Hard cap 20** — floor must always fit; extras truncate with a loud scream (`PREDEPLOY BENCH HARD CAP HIT`). The CLI clamps `--cap` / `PREDEPLOY_BENCH_CAP` values above 20; changing the ceiling requires a reviewed source change.

Preview selection with `cd agents && source venv/bin/activate && python
benchmarks/select_predeploy_benches.py --surface local --format report` (use
`--surface cloud` for cloud-compatible tasks). Repeat `--changed-file <path>` to
inspect a specific diff, or use `--changed-files-from <file>`. The selector keeps
the mandatory floor, deduplicates tasks, then adds history-qualified depth for
changed areas up to 20. Read its coverage gaps, history skips and dropped extras;
do not label tasks `smoke` or adjust their evaluators to force selection.

The 20-task selection cap is separate from execution concurrency. `bash scripts/run-predeploy-local` runs the selected tasks with concurrency 2 by default to avoid starving the shared local stack; `PREDEPLOY_LOCAL_CONCURRENCY` is an emergency/debug override. Use `--list` to preview names and `--history` for recorded timings. Cloud acceptance slices use their explicitly requested fleet width.

When adding a benchmark to `tasks.json`, auto-attach it to this algorithm:

- Set `deploy_category` to a known category (`payment`, `grep`, `sms`, `browser_stateful`, `browser`, `auth`, `plaid`, `phone`, `attachment`, `claude-code`, `research`, `response-schema`, `wait-for`, `chat`, `mass-agent`, `harness`) — or rely on matching tags (same names) for derivation
- Set `deploy_canary: true` if this task should be preferred as the one-per-category floor/path pick (otherwise shortest ready `pipeline-e2e` wins)
- Tag `smoke` **only** for must-run harness plumbing (always on the floor; counts toward the cap; no history gate)
- New category? Add it to `FLOOR_CATEGORIES` and/or `PATH_TRIGGERS` in `select_predeploy_benches.py` and to `KNOWN_DEPLOY_CATEGORIES`
- Never rename an existing task `name`
- Before benches run, the selector **always prints** `TOTAL SELECTED: N / 20` (and screams when the cap binds)

**The single full-suite entrypoint:** `scripts/run-bench eval` owns an isolated local stack and invokes `agents/benchmarks/run_eval_suite.py`. It runs every `status: "ready"` benchmark entry through `run_benchmark.py` and lists `status: "incomplete"` entries (missing fixtures/judges) as skipped. `scripts/run-bench eval --list` prints the holding set split by `rose-bench` vs. `pipeline-e2e`; `--bench rose-bench` or `--bench pipeline-e2e` runs one axis. The lower-level `run_eval_suite.py --port N` is for an explicitly reused running backend. Run the suite after every agent-harness change to evaluate whether progress is being made.

**The FE query box reads this same catalog** via `GET /api/benchmarks/test-prompts` (adapter in `back-end/src/domains/benchmarks/service.ts`); the dev test-prompts picker cannot drift from the suite.

**Every task runs on a base-image fixture.** Tasks that don't declare `environment.base_images` inherit the canonical `base:victoria-prod-sync-v1` artifact shared by local and cloud runners; declared environments with empty `base_images` inherit it too. That canonical base includes frozen WhatsApp history, while compute tokens are refreshed as a live overlay after restore. Registry + pg_dump freezer: `agents/benchmarks/fixtures.py` (`ensure_base_image_snapshot()`). Task-specific `db_fixtures` are deltas on top of the one canonical base image.

**Every completed run is recorded — pass or fail, local or prod.** `BenchmarkRun.save()` writes the full run record (message transcripts + logs) to `runs/*.json`, appends every attempt to the attempts ledger, and full LLM trajectories land in `.llm-dumps/<agent_id>/` (always-on locally; prod goes to ClickHouse).

**⛔ Never rename an existing task `name`.** The name is the primary key across all history stores; a rename orphans pass history and latency baselines:

- **Attempts ledger:** `agents/benchmarks/history/task_attempts.jsonl` — one line per _completed_ run (pass AND fail) with status, duration, cost, failure_reason. Written by `benchmarks/timeout_history.py:record_attempt()`. This is the run-stats record (attempt counts, failure rates).
- **Success ledger:** `agents/benchmarks/history/task_durations.jsonl` — one line per _passing_ run, keyed by `"task"`. Read via `benchmarks/timeout_history.py` (`summary()` → p50/p95, derived timeouts). Kept pass-only so failure durations can't poison timeout derivation.
- **p99/latency baselines:** `agents/benchmarks/history/span_durations.jsonl` — keyed by `"benchmark"` + `"span_key"`. Read via `benchmarks/span_history.py` / `agent_latency.py` (p50/p90/p95, regression flags).
- **Full run records:** `agents/benchmarks/runs/*.json` — per-run task results + merged logs, keyed by `TaskResult.name` (`run_benchmark.py --compare A B`).

One task name threads all three stores, so any eval is traceable end-to-end: definition (tasks.json) → pass history → latency profile → run record.

## Log Files

Check these when errors occur:

- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`
- **Mac App (console):** `mac-app/mac-app-console-logs.log`
- **Mac App (IPC):** `mac-app/mac-app-ipc-logs.log`
- **Docs:** `docs/docs-logs.log`

**Prod logs (for benchmark agents):** Benchmark runs auto-collect logs from retained ClickHouse rows and live service APIs into the result JSON (`agents/benchmarks/runs/*.json`):

- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **ClickHouse (retained Fly.io worker):** Agent execution logs from `observability.fly_logs`, retained 7 days — via `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` in `agents/.env`
- **Fly.io (live worker stream):** Live agent execution logs during benchmark runs — via `FLY_API_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.

## Debugging Slow Agents

Three diagnostic tools. Run **all three in parallel** whenever an agent is slow, stalled, or fails — they answer different questions. Then fully expand whichever one points at the smoking gun.

```bash
cd agents && source venv/bin/activate

# "Why was this slow/stalled?" — span-based cross-log waterfall + hot paths
python benchmarks/agent_latency.py <agent_id>
# Flags: -v (verbose/full tree), --speedscope OUT.json, --stall-threshold N,
#        --slow-threshold MS, --no-color

# "What errors happened where?" — event-timeline tree across worker/backend/messages
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
# Expand per-source: --source worker|backend|messages  (add --url <BASE> for prod)

# "How much did this cost / cache?" — tree-wide token + cache breakdown
python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>
# Cache metrics are tree-aggregated (root + all sub-agents via /api/tool-usage/tree/:id)
# Results stored in agents/benchmarks/runs/*.json

# "Where are cache hits/misses?" — file-tree view of prompt caching per LLM call
python benchmarks/agent_cache.py <agent_id>
# Flags: --all (all agents), --since 5m, --json, --log <path>
```

**`agent_latency.py`** reads `agents/navi-worker-log.txt` and `back-end/backend-logs.log`, builds a span tree from `span.start`/`span.end`/`db.query`/`broadcast.span` events (correlated by `span_id`/`parent_span_id`, falling back to `request_id` + time-window containment), and prints:

- Executive summary: re-run command, total duration, span count, error count.
- **Top 10 slowest paths**, **Slowest LLM Calls**, **Slowest Backend HTTP Requests**, **Errors** (deduped with counts).
- A hierarchical waterfall (`offset | dur | trace`) nesting sub-agents under their spawn call. Inline `IDLE` markers for gaps above `--stall-threshold`.
- `-v` expands every span (DB, broadcasts, HTTP internals).

**`agent_logs.py`** dumps the cross-source event timeline (including prod via Render, ClickHouse, and Fly APIs with `--url`), grouped into a tree with errors highlighted. Best for reading the exact error message + stack + surrounding context after `agent_latency.py` points at a layer.

For retained Fly.io worker logs, query ClickHouse directly:

```bash
cd agents && source .env
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"
```

**`agent_cache.py`** reads `agents/navi-worker-log.txt` for `llm.cache` events and renders a tree of cache read/write/hit% per LLM call, grouped by agent. Shows every call site (plan_loop, planner, verifier, explore, execute, chat) with its model, whether it used claudeAuth (direct Anthropic = $0) or waterfall, and per-call cache metrics. Use `--all --since 5m` for a cross-agent overview after running benchmarks.

Typical signatures to look for: `peer closed connection` during streaming, `[NO END]` on an LLM call (crashed/cutoff mid-stream), `Failed to fetch pricing` retries (underlying-model 404s burning 30s each), P2024 Prisma pool timeouts (5s × 3 retry on `db.findFirst`), 429 from Anthropic on the `claude_token` path (rate-limit fallback to waterfall), `thinking.adaptive.effort: Extra inputs` (effort must go in `output_config`, not `thinking`), 0% cache hit on claudeAuth (check `cache.prefix_fingerprint` hashes match across calls — differing hashes = different prefix = no cache reuse).

## Deploy command regression scheduling

`python3 scripts/run-deploy-structural-gates.py` runs the complete deploy
command registry with eight concurrent suites by default. Use `--max-workers N`
for a different host limit; this never changes benchmark fleet width. Fixture
startup/cleanup observations allow sixty seconds, and assert actual terminal
state, exact resource release, and real failures. Simulated review deadlines
use a controlled clock so host load cannot change the scenario.
Activate `agents/venv` before invoking the runner, and keep its `bin` before
Homebrew in `PATH`; otherwise child `python3` commands select a different
interpreter without the declared agent dependencies.
For the sandbox gate, inspect the retained test-run `summary.json` and
`claude-code.log` for the real smoke result; the outer command prints an aggregate.
A silent startup recurrence can use temporary `NODE_DEBUG=esm`, with all output
redirected to private `.context` artifacts. Keep those diagnostics out of git.
Semantic readiness checks session state and visible behavior; never add a
network-idle prerequisite to the realtime app's authenticated test helper.

### Worker generation verification

If `monitor-cooperative-cutover.ts --verify` reports a generation mismatch
after an exact-SHA CI success, compare the CLI's surface file list with that
same merged generation before treating the deploy as stalled. The generation
walker must use exact-case module paths on both Mac and Linux; class re-exports
must not create case-folded file aliases. Preserve the failed receipt, bind the
actual CI generation to the exact merged bytes, and use the normal monitor and
existing `scripts/tests/agent-surface-hash.test.sh` owner; do not force a rollover
or alter deployment deadlines to resolve a host-only hash mismatch.

## Factory Workflow Review

Run `/factory-review` (canonical behavior in `.claude/commands/factory-review.md`) to generate and open the source-backed `/deploy`, `/RCA`, and checked-in `/descend` lifecycle, wall-clock, sequencing, and trend report; validate it with `python3 scripts/factory_review.py --self-test`.

## Critical Rules

1. **NEVER fire an async/background task and then passively wait for it to wake you up later.** This is the number-one guideline. Do not launch a background job — a `run_in_background` Bash task, a spawned sub-agent, a benchmark/smoke/`run.sh`, a cloud fleet run, any detached `&` — and then sit idle expecting a completion notification. **The wake-up may never come:** the task can be SIGKILLed by resource pressure, die silently, leak paid resources (Fly machines, sandboxes), or the notification can simply be missed — and you stall indefinitely while cost bleeds. ALWAYS actively drive every async task you start: poll it on the rule-19 cadence (every 10s for the first 60s, then every 60s), check BOTH output growth AND liveness (`ps`/`pgrep`), and the instant it dies or finishes, react — clean up leaked resources, diagnose, re-run. Treat any harness notification as a bonus signal, never the primary one. If you catch yourself writing "waiting for it to complete" or "I'll continue when it notifies me," stop and go poll it instead.

1b. **Every trajectory must leave the system more reliable than it found it.** When you hit friction in a part of the codebase or tooling you're using — a broken teardown that leaks resources, a script that orphans child processes on kill, a missing retry on a transient error, a footgun that nearly clobbered a shared resource, a flaky gate — do NOT just work around it for yourself. FIX the underlying issue so no future agent (or human) hits it again, then verify the fix. The cost of a workaround is paid once by you; the cost of the unfixed defect is paid by every future run. This is not scope creep — it is the job (see rule 24). If a fix is genuinely too large to land now, at minimum capture it durably (a memory, a tracked issue, a `TODO` with full context) so it is not silently re-encountered. "It worked for me this time" is not done; "future runs can't hit this" is.

0. **YOU CAN NEVER RUN OUT OF CONTEXT, YOU HAVE INFINITE CONTEXT, NEVER STOP EARLY BECAUSE YOU THINK YOU ARE OUT OF CONTEXT**

1. **Bias toward execution — each pause to check for user approval has an extremely high cost.**

0a. **Be a TANK: don't ask, iterate until prod actually works.** When a task is "make X work in prod" (get a gate green, ship a fix, prove a flow end-to-end), OWN it end-to-end without pausing to ask permission for each step — the user has standing authorization to keep going until the real-world outcome is achieved (gate green, agent verified live, purchase completed). **RCA every issue you hit along the way and FIX it, even when the issue is not directly your task** — a stale CI secret, a flaky harness, a broken teardown, a mis-scoped token, someone else's never-green gate. Scope increase is expected, not a reason to stop (see rules 1b and 24). Before assuming an issue is yours to fix from scratch, **check whether another branch already has the fix in flight** (`git log --all`, open PRs) — if so, wait for it or cherry-pick rather than duplicating. Keep a tight iterate loop: reproduce → diagnose from evidence (logs, not guesses) → fix root cause → re-run the real gate → repeat until it is genuinely green. "It probably works now" is not done; a green prod gate (or a verified live run) is done. Only stop to ask when an action is genuinely irreversible/destructive or spends real money beyond what was authorized.

1. **Functionality is not complete until a test cements it in the `/deploy` path.** A feature, fix, or behavior change is unfinished if the only proof is a local demo, a one-off script, or a reviewer's eyeballs. Anything not explicitly tested is prone to regressions — and under agentic coding those regressions are EXTREMELY likely. The app is only as good as the suite that `/deploy` (or an equivalent recurring gate: blackbox, pre-deploy, daily) actually runs.

   Designing the test and its validation criteria is the main bulk of the work, not an afterthought after the implementation. Write the assertion first: what observable behavior must stay true, which suite owns it, and how `/deploy` will catch a silent break. Implementation is the smaller remainder.

   Functionality is only guaranteed if a test measures it and that test is cemented in a consistently-run path. Any behavior that lacks a cemented test is assumed broken until proven otherwise, and any bug we fix per RCA MUST land its reproduction test in the deploy process so the regression can never silently return.

   Every quick regression must run through the normal `/deploy` gates. Verify
   its registration and execution; a test file alone is not coverage. Extend
   the existing owning suite instead of adding a separate verification system.
   Adding larger tests or verification suites requires human approval.
   Native process-observation timeouts are read failures, not proof of a leak
   or absence. Keep bounded re-observation inside the existing owning gate;
   require positive parent/group/state evidence before cleanup. Teardown
   fixtures must include the runner's early EXIT-trap setup, and distinguish
   an executing child from an unreaped terminal child while joining their owners.
   Correlate timing diagnostics to the measured operation: a router-stream clock
   does not include later database or Temporal completion. Warn on inner elapsed
   observations; retain outcome, ownership and end-to-end completion checks.

2. **TDD loop** - Don't return until tests pass:

   ```
   while tests_failing:
       fix_errors()
       run_tests()
   ```

   When fixing a new issue that is not illuminated by a failing test:
   1. Diagnose the issue
   2. Create a test that reproduces the issue
   3. Fix the issue until the test passes
   4. Cement that test in a consistently-run suite (per rule 1) so the fix is permanent

3. **API changes require tests** - Add to `back-end/src/tests/blackbox/<domain>.blackbox.ts`

4. **No .md files** - Never create markdown docs unless explicitly requested

5. **Zod schema changes require approval** - Propose changes before implementing

6. **Follow RCA methodology for every bug** - Invoke `/RCA` (or read `docs/root-cause-analysis.md`) and follow the steps exactly. Never skip the evidence-gathering step (Step 0), never fix a symptom without tracing the critical path, never rationalize a failure as "pre-existing". **HARD GATE: never report a root cause without a LOCAL REPRO you ran and watched fail, plus a fix that makes that same repro pass. A theory ("probably load/a race/a 404") is not a deliverable — reproduce it or classify it as an open observability gap. For a benchmark failure, proxy tests do not prove the outcome: the exact unchanged task must also fail locally on the buggy revision and pass locally on the fixed revision via `scripts/run-bench --local <task>`.**

7. **Search before implementing** - When adding new features, first search the codebase for similar patterns (e.g., when adding a new tool, study existing tools)

8. **No fallbacks during development** - When testing a new integration, don't add fallback paths; they obscure whether the primary path actually works

9. **Frontend state diagrams required** - All frontend components must have a state machine diagram as a comment at the top of the file; reference and keep this diagram up to date when modifying state flow

10. **Feature changes require diagrams** - When implementing any feature, include a diagram showing how the change fits into the system context before writing code.

11. **Pauses are user-initiated, not fixes** - When debugging, NEVER assume a pause caused a bug/crash. The user sends a pause AFTER noticing something wrong. Pauses are the symptom reporter, not the cause.

12. **Short timeouts, check logs** - Never set bash timeouts longer than 5 minutes; use short timeouts and check task output periodically to ensure long-running tasks complete smoothly.

13. **Do NOT over-truncate** - Never aggressively truncate content, especially important context flows. Truncate SPARINGLY and only when necessary to fit content inside a frontend component (e.g., chip/bubble UI with limited space). When in doubt, keep the full content.

14. **Sync Conductor workspace name on branch change** - Whenever you switch or create a branch, update the Conductor workspace display name to match — **but only if it's not locked**:

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = '$(git branch --show-current)' WHERE directory_name = '$(basename \"$PWD\")' AND pr_title_locked = 0"
```

To manually rename and lock (prevents auto-sync from overwriting):

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = 'My Custom Name', pr_title_locked = 1 WHERE directory_name = '$(basename \"$PWD\")'"
```

15. **Plans must have automated verification** - Every plan's verification section must describe automated tests, not manual steps. Designing those tests and their validation criteria is the main bulk of the plan, not a short appendix. If no existing test route covers the change, create one. If you need API keys, configs, or other resources to test, ask for them in the plan. The goal: once a plan is approved, bring the feature all the way through to PR merged into main using `/deploy`.

16. **ALL test failures must be fixed — no exceptions** - Never rationalize test failures as "pre-existing", "not related to my changes", or "infrastructure issues." This applies to EVERY test tier: Prettier, ESLint, TypeScript, structural tests, coverage, blackbox tests, AND smoke benchmarks. If a test fails, you MUST fix it before proceeding. Do NOT skip, do NOT rationalize, do NOT merge with known failures. If smoke benchmarks fail due to expired tokens, fix the tokens. If they fail due to Temporal issues, fix Temporal. If they fail due to slow LLM responses, investigate and fix timeouts. "Infrastructure issue" is a diagnosis, not an excuse to skip. The local DB (Docker Postgres) must be running for blackbox tests — `run-blackbox-tests.sh` auto-detects the container via `CONDUCTOR_PORT`/`CONDUCTOR_WORKSPACE_NAME`. If the container isn't running, start it: `docker start victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}`.

17. **Bug diagnosis guidelines** - When diagnosing issues found while running any tests, follow `docs/root-cause-analysis.md` exactly. Gather evidence first, trace the critical path, classify the failure, and complete Step 5's hypothesis fields (including the generalizable Problem class) before writing any fix.

18. **Validate via blackbox tests, not hand-rolled scripts** - When validating credentials, tokens, integrations, or any pipeline behavior, run the existing blackbox test (e.g. `testSmoke_claudeCodeAnswersQuestion` in `back-end/src/tests/blackbox/claude-code.blackbox.ts`) — NEVER write ad-hoc curl/python scripts to hit Anthropic/Supabase/etc. directly. The blackbox exercises the FULL path (DB read → decryption → E2B sandbox → Claude Code CLI → Anthropic) the way production does; a raw curl only tests one hop and misses layer-specific bugs. If no blackbox covers the case, extend the existing suite first, then run it.

19. **Background-task monitoring cadence** - Whenever a long-running task is launched in the background (smoke suites, benchmark runs, `run.sh`, agent polling, any `run_in_background=true` bash, or a raw `&` shell job), monitor it on this schedule:
    - **First 60 seconds:** poll every **10 seconds**. Catches silent early deaths (0-byte log, missing env, queue mismatch, PID died at startup). Check both log growth AND `ps -p <pid>` — a dead PID with no output means the task never started.
    - **After 60 seconds:** poll every **60 seconds**. The early-death window is over; longer intervals save context and tokens.
    - **Exit the moment the task finishes.** The instant you see the completion signal (exit code, "RESULTS: N/N passed", PID gone, "DONE" line), stop polling and move on. Do NOT sleep out the remaining interval. Do NOT keep polling after completion "to be safe."
    - This rule is universal — it applies everywhere, not just in `/deploy`. If a background task burns 10+ minutes before you notice it died, that is a rule-19 violation.

20. **Temporal activities must be idempotent** - Temporal activities are at-least-once. Any activity can run, complete its external side effect, and then fail to report completion back to Temporal because the worker-to-Temporal completion RPC was canceled, disconnected, or otherwise not recorded. Temporal will then retry the activity after the attempt timeout. Therefore every activity that writes to the backend, calls an external service, creates files, sends messages, charges money, or performs any other side effect MUST be safe to run more than once. Before performing a side effect, check whether the intended result already exists and return it when possible; otherwise use an idempotency key/deduplication record so retries do not duplicate work. Never assume "the activity returned locally" means Temporal recorded completion.

21. **Never `git stash`** - The stash ref is shared across all worktrees in this repo; popping can pull another workspace's in-flight work. Instead: `git diff HEAD > .git-wip.patch && git checkout -- .`, then `git apply .git-wip.patch && rm .git-wip.patch` to restore.

22. **Never disable linters** - Do NOT add `eslint-disable`, `// eslint-disable-next-line`, `/* eslint-disable */`, `// @ts-ignore`, `// @ts-expect-error`, `# noqa`, `# type: ignore`, `# pylint: disable`, `ruff: noqa`, or any equivalent escape hatch to silence a rule. Fix the underlying issue. Existing disables in the codebase should be removed when you touch the file.

23. **New user data providers** - When integrating a new user data provider, first model it as a normalized, grep-searchable document source with explicit sync state, source metadata, snapshot revision semantics, prod-path tests, and a prod-data benchmark before adding bespoke provider behavior.

24. **Clean up tech debt as you discover it — scope increase is expected** - When a file under edit has pre-existing lint errors, type errors, test failures, dead code, or other debt, fix it in the same PR. Do NOT rationalize "pre-existing" or "out of scope" to leave it. Scope increase beyond the narrow task is not only allowed but anticipated — bundle the cleanup with the change that exposed it. **Any error surfaced by a failing test, lint, typecheck, coverage check, or other gate is automatically in scope — even in files you did not touch.** If the deploy pipeline (or any required check) reports the error, fix it; do not skip it as "not my file" or "not my change."

25. **No benchmark reward hacking** - Never change benchmark task definitions, prompts, expected tools, pass criteria, load sizes, timeouts, concurrency limits, or production behavior just to make a benchmark pass. Do not raise a benchmark/tool timeout as a workaround for a timeout failure. First prove why it timed out with diagnostics: resource contention, memory growth, blocked external tool/session, retry loop, verifier/schema issue, slow database/API calls, or an unintended parameter/config change. Then reduce the underlying resource use, remove the stall, or fix the broken flow. Get explicit approval before changing any benchmark definition or timeout. General reliability rule: any Temporal activity wrapper that calls an LLM must allow at least 60 seconds; sub-60-second verifier/LLM activity timeouts are product bugs, not benchmark tuning.

25a. **Never add runtime nudges to the harness** — synthetic user/tool messages injected into the planning LLM's trajectory (network monitors that fabricate tool failures, supervisor recovery nudges, skip-recovery guards, OTP/handoff autofill, classifier recovery constraints wired into message assembly, etc.) are almost always overfitting. Let the model act on real tool results. Deploy Step 0c requires human approval if you touch harness trajectory-injection sites.

25b. **Avoid string-matching classifiers in our harness** — that is an ANTI-PATTERN.

26. **Prompt approval is snapshot-scoped** - Human approval for prompt, instruction, command, skill, or prompt-related changes applies only to the diff that existed when approval was requested. If any later fix or test iteration adds or changes prompt-related files, stop and request fresh approval for those additional hunks before running deploy with the prompt approval flag. Never treat "prompt changes approved" as blanket permission for future prompt edits.

27. **DO NOT KILL OTHER RUN-BENCH TASKS. EVER.** - Cloud benchmark controllers (`run-bench-fleet`, `run-bench-cloud`, `run-bench-hub-poller`) and their children may belong to OTHER workspaces/sessions sharing this machine. Broad kills (`pkill -f run-bench`, `pkill -f flyctl`, `pkill -f benchmark`, killing by port scans, etc.) have repeatedly murdered healthy 28-machine fleets mid-run from the outside. Rules: (a) NEVER pkill by a pattern that could match a benchmark process you did not launch in THIS session; (b) to stop YOUR OWN run, TERM exactly its controller PID (printed at launch; also in its detached log path / run dir) and let its cleanup traps reap machines/volumes — never kill children directly; (c) if a run you don't own looks stuck or abandoned, surface it to the user — killing it is the user's call, not yours. Controllers announce received signals (`⚰️ controller received TERM`) — check the victim's detached log before assuming an infra failure.

28. **Every change must hold at 10k agents** - The design target is 10,000 concurrent agents. Before shipping ANY change, ask "what happens to this at 10k agents?" and reject designs that degrade with agent count. Concretely: no per-user/per-root fan-in that funnels many agents' traffic through one channel, connection, subscription, row, lock, or in-memory structure (e.g. broadcasting every agent's realtime stream onto a shared `user:<userId>` topic is a firehose that melts at scale — keep per-agent isolation like `agent:<id>`); no unbounded per-agent polling, N+1 queries, full-table scans, or O(agents) work on a hot path; no shared mutable state, global counter, or single-writer bottleneck that every agent contends on; no realtime/broadcast/DB pattern whose cost grows with the number of agents a user or tree owns rather than with the one agent being acted on. Prefer per-agent isolation, bounded/backpressured work, sharded/keyed resources, and derive-don't-accumulate. A fix that resolves a 1-agent symptom but scales O(agents) is not a fix — state the 10k-agent behavior of your change (channels opened, subscriptions held, rows/queries per agent, bytes per broadcast, lock contention) in the RCA/PR before merging.

## Plans

All implementation plans live in `docs/plans/` (checked into the repo):

- `docs/plans/active/` — plans currently being implemented
- `docs/plans/completed/` — plans that have been shipped

Plan filenames should be kept in sync with the description of the task (kebab-case, e.g., `context-pointers.md`).

**Before modifying a file**, check `docs/plans/completed/` for plans that touched those files. Read them to understand implicit business functionality and ensure changes don't break it.

The `/deploy` skill automatically moves the related plan from `active/` to `completed/` before merging (if one exists).

## Temporal/Agent Patterns

- Workflows must be **deterministic** - no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** - safe on retry
- Activities may run on **any machine** — never rely on module-level shared state; add backend-API fallback (Claim Check pattern)
- Keep activity args small and serializable (IDs, names, flags) — resolve rich objects inside the activity; args accumulate across long workflows toward the 2MB payload limit
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
- **Backend API key:** read `BACKEND_API_KEY` from the authoritative `agents/.env` and `back-end/.env` files; preserve their matching value.
- If a test fails due to an invalid GPT auth token or invalid Claude auth token, retry with the token stored locally on the computer, or refetch the ones stored in the prod database — do not escalate before trying these.

**Query backend locally:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" -H "X-API-Key: $BACKEND_API_KEY"
```

## Database

- **ORM:** Prisma
- **RLS:** Enabled on all tables - users only see their own data
- **Realtime:** All realtime events use explicit HTTP broadcasts to Supabase Realtime (`POST /realtime/v1/api/broadcast`). `createMessage()` auto-broadcasts INSERT events; `updateAgentStatus()` auto-broadcasts UPDATE events. No DB triggers are involved.
- **Schema changes MUST ship a migration** — do NOT rely on `db push`. Local dev/setup (`scripts/run.sh`, `scripts/setup-db.sh`) run `prisma db push --accept-data-loss`, which silently conjures the DB from `schema.prisma`, so blackbox/local tests pass even with NO migration. Prod (`render.yaml`) runs `prisma migrate deploy`, which ONLY applies committed migration directories. A schema edit without a migration therefore works locally and **500s in prod** ("table/column does not exist" → e.g. every compute-token fetch fell to the paid waterfall on 2026-07-06). Correct path:
  1. Edit `back-end/prisma/schema.prisma`.
  2. Author the migration WITHOUT `prisma migrate dev` — its shadow DB replays the whole history including the squashed baseline (`00000000000000_init`), which contains Supabase RLS policies (`auth.uid()`) + `realtime.*` triggers that don't exist on a plain local Postgres shadow, so `migrate dev` fails. Instead diff your edited schema against the current local DB (no shadow):
     `mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<desc> && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<that-dir>/migration.sql`
     (run BEFORE `db push`, while the local DB still reflects the old schema). Review the SQL, then `npx prisma db push` to apply locally. A loose `.sql` in the migrations root is IGNORED by `migrate deploy` — it MUST be `<timestamp>_<name>/migration.sql`.
  3. Commit the migration directory with the schema change. `src/tests/structural/migration-drift.test.ts` fails the build if `schema.prisma` has a model/column with no migration (both directions).
- **Migration history is a single squashed baseline** (`00000000000000_init`, from a `pg_dump` of prod on 2026-07-06 via `back-end/scripts/clean-baseline-dump.py`). It reproduces prod exactly — tables, enums, indexes (incl. the `pg_trgm` expression index), functions, triggers, and RLS policies — and existing DBs have it `migrate resolve --applied`. To re-baseline after major drift, re-run that script on a fresh `pg_dump` and re-resolve.
- **Query DB:** `npx tsx back-end/scripts/query-db.ts` (modify script as needed)

## Supabase Realtime Messages

All realtime and tool message types are defined in `front-end/src/lib/realtime-types.ts`.

## Rose Completions

In-process model racing (claudeAuth → OpenRouter waterfall). No external HTTP hop.

Python waterfall TTFT/progress guards belong inside each configured leg. Before
productive output, a stalled leg may use the existing next model; partial-output
idle errors and the fixed whole-call deadline remain terminal. Do not raise the
590/90/120 browser budgets to hide this distinction. Run the normal deploy-owned
`cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py rose rose-browser-use llm`
for client or waterfall edits. These suites include fallback, original deadline,
parser progress, cancellation and response-closure controls. Browser collect
failures retain their built inputs and requested configuration through the
existing best-effort dump path, with the same request/span/root and cache
bindings. Capture failure preserves the original exception; cancellation and
successful browser dumps are unchanged. Older failed calls may still lack an
exact input dump; earlier successful dumps are not substitutes.
See `docs/rca/cases/2026-10-06-client-stream-guard-bypassed-waterfall-fallback.md`.

- `back-end/src/providers/rose/` - TS client (chat path: router/generator/supervisor)
- `agents/providers/rose/` - Python client (agent/browser-use path)
- `back-end/src/providers/rose/pools.ts` / `agents/providers/rose/pools.py` - Canonical pool registry (`rose-1-flash`, `rose-1-ultra`, `rose-1-browser-use`)
- `back-end/src/routes/agents.ts` - Agents API (create, poll, pause/resume)
- `back-end/src/providers/hybridAuth.ts` - API key authentication. There is NO
  `src/middleware/` directory — both auth middlewares (`auth.ts`, `hybridAuth.ts`)
  live in `src/providers/`. Grepping the old path silently returns nothing, which
  is how a whole authentication path was missed during an RCA.

## Planner Memory (trajectory RAG over finalized runs)

`call_planner_llm_activity` retrieves compressed memories of past runs with similar goals and forks a native
`get_memories` tool call + tool result onto the END of the planner context (never into the system prompt), so the
cached prefix (tools + static system prompt + conversation) is byte-identical with or without hits. Per-agent
`memory_enabled` (create body / `Agent.memoryEnabled`, sub-agents inherit) gates it; benchmarks default it off.
Code: `agents/providers/planner_memory/`, backend `src/domains/planner-memory/` + `src/providers/plannerMemoryStore.ts`.

- **History table = the RAG corpus.** `PlannerMemory` gets one row per finalized root bundle, written in the same
  archive finalize that publishes the R2 manifest (`traceArchiveLifecycle.finalizeAgentOnce`), so table and archive
  never drift (cemented by `back-end/src/tests/blackbox/planner-memory.blackbox.ts`). `criticalPath` is a TTL-free
  cache: the first planner that retrieves an uncompressed row reads the bundle, runs the compressor once (`compressor.py`,
  prompt capped at 100 lines by test), and PATCHes it back. No cron, no index build.
- **Retrieval:** one indexed Postgres query (`to_tsvector` GIN + `pg_trgm`) → in-process scoring (`retrieval.py`,
  `RetrievalConfig` = strategy + absolute cutoff chosen by `agents/benchmarks/memory_retrieval_bench.py` on the frozen
  labels in `agents/benchmarks/fixtures/memory/retrieval-labels.json`). Returning 0 or 1 memories is normal.
- **Tool history is native:** the planner declares a constant declared-only toolset (plan-phase tools +
  `get_memories`, `planner_context_tools()`); structured output keeps `output_config`, `tool_choice` is `none`. The
  waterfall (no declarations) flattens the fork to text via `flatten_tool_history_to_text`. `build_planner_messages`
  keeps real assistant `tool_calls` / `role: tool` pairs (no `[TOOL]:` flattening).
- **Proof (real planner LLM calls):** `cd agents && python benchmarks/run_memory_scenarios.py --port N` runs
  `agents/benchmarks/memory_scenarios.json` (31 scenarios from archived runs + 2 negative controls, fit/held-out split)
  memory off vs on and writes `.context/memory-dashboard/index.html` with the exact injected context per scenario.
  Registered in `scripts/test.sh` (smoke tier) together with `benchmarks/run_memory_compressor_bench.py`, which runs the
  compressor on real completed transcripts (`memory_compressor_cases.json`: one per task + the largest runs, up to
  10k messages) with generic transcript-grounded assertions (tool names, URLs, no PII, bounds). Catalog A/B:
  `planner-memory-blue-bottle-off` / `-on` (`start_phase: plan`, `success_on_plan`, `plan_shape` static checks,
  `environment.memory_fixtures`). Backfill history rows after deploy: `python scripts/backfill_planner_memory.py --stats`
  then `--backend <prod url>`; only completed runs are ever retrieved or compressed.
- **Fixtures:** `python scripts/build_memory_fixture.py --name <n> --bundle-id <root_agent_id>...` compresses real
  bundles into `agents/benchmarks/fixtures/memory/<n>.json`; `run_benchmark.py` loads them into the local stack's
  history table (internal PUT) for `memory: "on"` tasks. Global kill switch: `PLANNER_MEMORY_ENABLED=0`.

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

### Prod health / latency dashboard (golden signals)

**"Is the backend slow right now?"** → one call: `cd back-end && npx tsx scripts/prod-health.ts`. It pulls Render request logs for a window and prints the four golden signals in a single view: **latency** (per-endpoint p50/p90/p99/max, routes templatized so `/api/agents/<uuid>` aggregates), **traffic** (req counts), **errors** (4xx/5xx per route + total), and **saturation** (slowest Prisma ops + a `EMAXCONN`/max-connection banner and deploy/instance state). Each endpoint's p90 is diffed against a rolling historical baseline the script persists to `scripts/.prod-health-history.jsonl` (gitignored) and appends to on every run — so `▲ +180%` flags a real regression vs. normal.

```bash
npx tsx scripts/prod-health.ts               # last 30m vs history
npx tsx scripts/prod-health.ts --window 2h   # wider window
npx tsx scripts/prod-health.ts --top 30      # more routes
npx tsx scripts/prod-health.ts --json        # machine-readable (for scripting/alerts)
npx tsx scripts/prod-health.ts --history     # inspect the stored baseline
npx tsx scripts/prod-health.ts --no-record   # don't append this run to history
```

Reads `RENDER_*` from `back-end/.env`; backs off on Render's log-API 429s. Typical culprit for a p99 spike with a pool-saturation banner: a Render deploy cutover (old+new instance Prisma pools exceed the Supabase pooler client cap → queries queue to Prisma's ~30s pool-acquisition timeout → `EMAXCONN`). Guarded since 2026-07: `providers/database.ts` derives `connection_limit` from the pooler budget (`POOLER_MAX_CLIENT_CONN`, set to 1000 on Render for the XL compute tier; code default 400) minus the fast-cache pool (`FAST_CACHE_DB_POOL`), cemented by `src/tests/structural/db-pool-invariant.test.ts`. DB is Supabase XL (4 dedicated cores, 16GB, `max_connections=240`, Supavisor `pool_size=60`).

## Production Env Vars

**You (Claude) own env-key management:** when you mint or rotate a credential, store it in every correct location — the relevant local `.env`, the matching prod surface(s) below, AND the Codex-cloud `rose` environment — never leave a key only in chat.

- **Render backend:** read `cd back-end && npx tsx scripts/render-env.ts` (all keys, masked), `npx tsx scripts/render-env.ts KEY [KEY...]` (exact values), or `--json`. **Do NOT hand-roll `curl .../env-vars?limit=100`** — Render caps a page at 100 rows and returns a cursor on the last row, so a raw `limit=100` silently drops everything past the first page. The service is already at 117 vars; on 2026-08-05 that made `AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS` read as unset when it was present. A missing var and a truncated page are indistinguishable, so the script paginates and refuses to report a partial list as complete. Set: `cd back-end && source .env && curl -s -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/KEY" -d '{"value":"VALUE"}'`; MANDATORY: User Approval Needed to Write Env Vars.
- **Fly agents:** read `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets list -a navi-whisper-lux`; set `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets set KEY=VALUE -a navi-whisper-lux`; MANDATORY: User Approval Needed to Write Env Vars.
- **Vercel frontend:** read `cd front-end && vercel env ls production`; set `cd front-end && vercel env add KEY production`; MANDATORY: User Approval Needed to Write Env Vars.
- **Supabase functions:** read `cd agents && source .env && supabase secrets list --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; set `cd agents && source .env && supabase secrets set KEY=VALUE --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; MANDATORY: User Approval Needed to Write Env Vars.
- **Codex-cloud `rose` environment:** the cloud sandbox env that mirrors backend secrets. Every key set on Render must also be mirrored here (and vice-versa). Set via the Codex cloud environment settings UI. MANDATORY: User Approval Needed to Write Env Vars.

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
  -H "X-API-Key: $BACKEND_API_KEY" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "...", "start_phase": "plan"}'
```

Use `"start_phase": "plan"` to bypass chat mode and go directly into the Temporal workflow (plan → execute).
Use `"start_phase": "execute"` to skip planning too. Omit `start_phase` for normal chat mode.

**3. Poll messages every 10 seconds via GET agent detail:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" \
  -H "X-API-Key: $BACKEND_API_KEY" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
```

Messages are in the response under `.messages[]`. Each message has `role`, `message`, and `metadata` (JSON with `toolName`, `toolStatus`, `title`, etc.).

**4. On ANY unexpected behavior, IMMEDIATELY follow this strict sequence (no exceptions):**

```
Step 1: DELETE the agent (stop bleeding tokens)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: $BACKEND_API_KEY" \
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

| #   | Call Site                                                         | Model       | claudeAuth | Forces Ultra | Context Composition                                                                                                   | Est. Tokens |
| --- | ----------------------------------------------------------------- | ----------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| A1  | **Main Loop (PLAN)** `loop/run_agent.py` → `call_llm_activity`    | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 4 PLAN tool schemas (500t) + conversation + blueprints          | 3-20k       |
| A2  | **Planner LLM** `helpers/llm.py:call_planner_llm_activity`        | agent.model | YES        | no           | `build_planner_system_prompt` (3k) + user_context + conversation. **skip_cache=True**                                 | 5-15k       |
| A3  | **Verifier (PLAN)** `helpers/llm.py:check_progress`               | agent.model | YES        | no           | `build_verifier_prompt` (500t) + full conversation (USER+TOOL only, no SYSTEM/ASSISTANT)                              | 3-40k       |
| A4  | **Main Loop (EXECUTE)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 6 EXECUTE tool schemas (800t) + full conversation + DAG results | 5-80k       |
| A5  | **Verifier (EXECUTE)** `helpers/llm.py:check_progress`            | agent.model | YES        | no           | Same as A3 but with execute-phase conversation                                                                        | 5-80k       |

### Sub-Agent LLM Calls (spawned from EXECUTE phase)

| #   | Call Site                                                                             | Model        | claudeAuth | Forces Ultra | Context Composition                                                                                                                                                 | Est. Tokens |
| --- | ------------------------------------------------------------------------------------- | ------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| S1  | **Explore Agent** `tools/spawn_agent.py` → `run_agent`                                | rose-1-flash | **NO**     | no           | `EXPLORE_AGENT_SYSTEM_PROMPT` (300t) + **network_metadata (2k contacts, 5-15k t)** + local_data_summary + 4 tools (web_search, web_fetch, grep, attempt_completion) | 2-25k       |
| S2  | **Browser Agent** `tools/spawn_browser_agent_v3.py` → `call_llm_structured_streaming` | agent.model  | YES        | no           | `build_browser_system_prompt` (400t) + step history + screenshots (multimodal, heavy)                                                                               | 5-30k       |
| S3  | **Sub-Agent** spawns full workflow (A1-A5 repeat)                                     | parent.model | YES        | no           | Inherits parent user_context (gatable via context_gates) + own conversation                                                                                         | recursive   |

### Tool-Level LLM Calls (inside activities)

| #   | Call Site                                                   | Model               | claudeAuth | Forces Ultra | Context Composition                                                    | Est. Tokens     |
| --- | ----------------------------------------------------------- | ------------------- | ---------- | ------------ | ---------------------------------------------------------------------- | --------------- |
| T1  | **message_person** `tools/message_person.py` → `call_llm`   | agent.model         | **NO**     | no           | system prompt with conversation history + person thread + user message | 1-5k            |
| T2  | **Deep Research** `tools/deep_research.py` → Perplexity API | sonar-deep-research | N/A        | N/A          | system prompt + query (separate provider, separate billing)            | ~500 in, 8k out |

### claudeAuth Flow

- User's Claude OAuth token fetched at workflow start (`fetch_claude_max_token_activity`)
- Passed to Rose completions endpoint as `claude_token` param
- Rose routes directly to Anthropic API, skipping racing ($0 cost to Rose)
- Detected in response: `actual_model` ending with `-claude` suffix (e.g. `claude-sonnet-4-6-claude`)
- Refreshed before EXECUTE phase in case it expired during PLAN

### Context Gates per LLM Call

Each LLM call site, the context chunks it receives, and which `context_gates` key controls each chunk.

**Gate keys:** `user_profile`, `authenticated_sessions`, `integrations`, `recent_communications`, `network`, `custom_system_prompt`, `shared_files`

| LLM Call              | Context Chunk                                 | Gate Key                 | Est. Tokens | Notes                                           |
| --------------------- | --------------------------------------------- | ------------------------ | ----------- | ----------------------------------------------- |
| **A1/A4 Main Loop**   | user profile (name, phone, address)           | `user_profile`           | 50-100      | Via `get_user_context` → `build_system_prompt`  |
|                       | authenticated browser sessions                | `authenticated_sessions` | 20-50       |                                                 |
|                       | connected integrations (Gmail)                | `integrations`           | 20-30       |                                                 |
|                       | 200 recent messages (24h)                     | `recent_communications`  | 2-10k       | **Heaviest chunk**                              |
|                       | 2000 contacts network                         | `network`                | 5-15k       | **Heaviest chunk**                              |
|                       | custom system prompt                          | `custom_system_prompt`   | 0-500       | User personality injection                      |
|                       | file attachment resolution                    | `shared_files`           | variable    | Base64 images, text files                       |
|                       | system prompt (identity, phase, tools, rules) | _always on_              | 2-3k        | `build_system_prompt`                           |
|                       | conversation history                          | _always on_              | 1-50k       | Grows per iteration                             |
|                       | blueprints                                    | _always on_              | 0-2k        | Iteration 1 only                                |
| **A2 Planner**        | user_context (pre-gated)                      | _inherits parent gates_  | 0-15k       | Same gates as A1                                |
|                       | planner system prompt                         | _always on_              | 3k          | `build_planner_system_prompt`                   |
|                       | conversation history                          | _always on_              | 1-10k       |                                                 |
| **A3/A5 Verifier**    | verifier system prompt                        | _always on_              | 500         | `build_verifier_prompt`                         |
|                       | full conversation (USER+TOOL)                 | _always on_              | 3-80k       | No gates, no truncation                         |
| **S1 Explore**        | 500-contact network metadata                  | `network`                | 5-15k       | Via `fetch_full_network_metadata`               |
|                       | local message thread summary                  | `recent_communications`  | 0-2k        | Via `fetch_local_data_summary`                  |
|                       | explore system prompt                         | _always on_              | 300         | `EXPLORE_AGENT_SYSTEM_PROMPT`                   |
|                       | 4 tool schemas                                | _always on_              | 400         | web_search, web_fetch, grep, attempt_completion |
| **S2 Browser**        | browser system prompt                         | _always on_              | 400         | `build_browser_system_prompt`                   |
|                       | step history + screenshots                    | _always on_              | 5-30k       | No user context, no gates                       |
| **S3 Sub-Agent**      | _all chunks from A1_                          | _inherits parent gates_  | recursive   | Gates set by parent's `spawn_agent` call        |
| **T1 message_person** | cross-contact voice sample                    | `recent_communications`  | 1-5k        | `fetch_recent_messages_activity`                |
|                       | 1-on-1 thread with person                     | _always on_              | 0-3k        | Always needed for context                       |
|                       | Exa person enrichment                         | _always on_              | 0-1k        | Always needed for personalization               |
| **T2 Deep Research**  | system prompt + query                         | _always on_              | ~500        | Perplexity, separate billing                    |

### Remaining Waste (not gatable)

1. **A3/A5 Verifier** - Gets full conversation with no truncation. On long runs (20+ iterations) this balloons to 40-80k. Not yet gated.
2. **T1 message_person** - `call_llm` doesn't pass `claude_token`. Small per-call cost.
3. **Schema gen** (`setResponseSchema.ts`) - Forces Rose Ultra for a simple task. Rose Flash would suffice.

## CodeRabbit Review

`/deploy` owns CodeRabbit's bounded state machine: one automatic initial review,
one batched incremental review, and at most one verification review. Never
review every intermediate push or use `gh pr checks --watch`; use
`scripts/wait-for-code-review` for the exact immutable HEAD, batch all valid
findings before pushing, and require `deploy_review_cycle.py require-mergeable`
before merge. A fourth cycle blocks the deploy as review-unstable.

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.
