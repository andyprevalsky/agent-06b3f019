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
```

> **Reference repos policy:** `openclaw/`, `hermes-agent/`, and `codex/` are gitignored
> (sit alongside `claude-code-src/` but are NOT committed). Treat as
> read-only research material — do not edit them. If they're missing on a
> fresh clone, run `bash scripts/sync-reference-repos.sh` to restore.

## Prompt review tool

`prompt-review/` ships a small local web app for reviewing every prompt in
this repo against reference codebases side by side. Columns:
**current → ~1 month ago → Claude Code → OpenClaw → Hermes → Codex**. Notes are
saved per prompt; checkpoint state persists across reloads.

```bash
bash prompt-review/run.sh                     # rebuilds data + launches on :8765
PROMPT_REVIEW_PORT=9000 bash prompt-review/run.sh   # custom port
```

- Catalog: `prompt-review/catalog.json` (edit to add/remove prompts).
  Each OUR entry has a `matches` field with hand-picked semantic pairings
  for each reference repo (`claude`, `openclaw`, `hermes`, `codex`); a value of
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

**Cloud runner quick start:** From a configured clone, run
`scripts/run-bench list`, then `scripts/run-bench <task> --wait` for one real
isolated benchmark. For an infrastructure streak, use
`scripts/run-bench stability-proof -k 10 --concurrency 10 --seed <integer>
--exclude-file <prior-successful-names.json> --min-successful-llm 3`;
the exclusion file is a JSON array of task names already used in accepted
earlier runs. Capability slices
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
isolation. Both are discovered by the backend blackbox runner in `/deploy`.
These causal tests do not prove that an earlier live OOM had the same allocation
source; retain its evidence and verify fresh fleet outcomes separately.
Credential CDP connection and browser-state injection default to 18 seconds;
`BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS` and `BROWSER_STATE_INJECTION_TIMEOUT_MS`
override those infrastructure budgets. Origin-payload SQL uses the configured
state budget too. This approved 20% headroom does not change benchmark execution
backstops, the fleet E2E cutoff, or evidence and teardown requirements.

Run durable publication with the agents environment, for example
`agents/venv/bin/python scripts/publish_evidence_links.py --run-json <run.json> --agent-id <id>`.
Transcript verification must follow both root-message ownership and the actual
renderer: user/attachment text is literal; assistant Thoughts use Markdown.
Use the existing CommonMark parser with GFM table/strikethrough rules for snippets, preserving literal
delimiter runs and line boundaries. A fresh-browser timeout can mean the verifier
expected text the UI never renders; capture that exact predicate before changing
timeouts. The existing publisher browser-validation blackbox owns these cases.

PR #1299's infrastructure acceptance requires **ten consecutive slices of ten
benchmarks**, with **at least three successful LLM queries per benchmark's own
agent tree**. Verify completed provider responses with correlated, nonduplicated
trace evidence; input dumps, attempts, and aggregate counters alone do not prove
success. Do not add calls or alter tasks to reach the minimum. Infrastructure
failures during execution, evaluation, artifact collection, or teardown prevent
credit even when a task verdict exists. Verify each slice's exact resource
cleanup and ten durable FE/LLM evidence bundles before advancing. The normal
execution backstop is 7,200 seconds. The user's temporary 300-second validation
backstop can count only when every bench still has at least three completed LLM
responses, a real evaluator result, and full cleanup/evidence; an interrupted
diagnostic that misses those requirements earns no credit. Restore the normal
backstop after this validation. These are proof acceptance requirements, not
changes to benchmark pass criteria or deploy-selection qualification.
Benchmark request identity is scoped per task; exact resource cleanup temporarily
overrides it with the persisted root owner. Preserve that precedence and restore
both scopes on cancellation. The existing cleanup and benchmark identity tests
cover concurrent siblings, preflight failures and callback/result contracts.
The live-query verifier also rejects an owned terminal `rose.complete.failed`
inside the benchmark's execution window, even if three other calls completed.
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
resources, and grant no slice credit. Never relabel an interrupted bench as a
normal evaluator `FAILED` or waive the three successful LLM responses. Restore
the 7,200-second backstop after this requested validation.
After each valid slice, report the whole slice's wall-clock time and every
bench's individual wall-clock time (including startup, evidence collection and
teardown, alongside the task-execution duration where available). Inspect the
critical path and task trajectories before advancing: provider retries and
latency, browser steps and session recording, archive writes, evaluator timing,
and cleanup receipts. Recovered errors must be checked for lost evidence or a
material slowdown. Include compatible smoke-tagged tasks where the selected
suites provide them; a one-response chat smoke cannot qualify by adding synthetic
calls. For the current campaign, the user waived routine speedup reviews while
whole-slice and individual-benchmark end-to-end wall clocks stay within 20 minutes.
Inspect actual spikes above that threshold without speculative optimization or
changes to tasks, prompts, models, scoring, evidence or result classification.
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
For the current campaign, draw 100 distinct tasks from the canonical `daily`
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
`scripts/run-bench-fleet --recover-stale-owner <exact-owner-token>`. A task
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
daily fleets' reservation budget. The dedicated profile is under live PR #1299
verification; passing resource tests alone is not a benchmark outcome.
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
  per-workspace queue). `BROWSER_PROVIDER` must be `kernel` or `steel`. When
  something is misconfigured despite a correct `.env`, check for an injected env
  var of the same name first.
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

- Set `deploy_category` to a known category (`payment`, `grep`, `sms`, `browser_stateful`, `browser`, `plaid`, `phone`, `attachment`, `claude-code`, `research`, `response-schema`, `wait-for`, `chat`, `mass-agent`, `harness`) — or rely on matching tags (same names) for derivation
- Set `deploy_canary: true` if this task should be preferred as the one-per-category floor/path pick (otherwise shortest ready `pipeline-e2e` wins)
- Tag `smoke` **only** for must-run harness plumbing (always on the floor; counts toward the cap; no history gate)
- New category? Add it to `FLOOR_CATEGORIES` and/or `PATH_TRIGGERS` in `select_predeploy_benches.py` and to `KNOWN_DEPLOY_CATEGORIES`
- Never rename an existing task `name`
- Before benches run, the selector **always prints** `TOTAL SELECTED: N / 20` (and screams when the cap binds)

**The single full-suite entrypoint:** `cd agents && python benchmarks/run_eval_suite.py --port N`. It runs every `status: "ready"` benchmark entry through `run_benchmark.py` and lists `status: "incomplete"` entries (missing fixtures/judges) as skipped. `--list` prints the holding set split by `rose-bench` vs. `pipeline-e2e`; `--bench rose-bench` or `--bench pipeline-e2e` runs one axis. Run this after every agent-harness change to evaluate whether progress is being made.

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
- Backend API Key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
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
