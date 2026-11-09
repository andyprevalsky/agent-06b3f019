## Failure handling during deployment

When these suites are run by `/deploy`, apply
`.claude/shared/deploy-failure-policy.md` to failures. Required checks retain
their actual outcomes; a qualified delegation waiver or external-provider
exception is not a passing test. Standalone test and benchmark work retains its
own acceptance criteria.

# Testing

Single source of truth for running tests. All commands run from the repo root.

## Quick Start

```bash
bash scripts/test.sh --port=3001                   # everything: offline + smoke + semantic (requires running services)
bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + Playwright semantic)
bash scripts/test.sh --no-smoke agents             # single repo (offline)
bash scripts/test.sh --no-smoke agents web-search  # single domain (offline)
bash scripts/test.sh --no-smoke back-end auth      # backend blackbox: auth domain
bash scripts/test.sh --list                        # list available repos/domains
```

## Test Suites

| Suite                            | Command                                                          | Server Required   | Filtering    |
| -------------------------------- | ---------------------------------------------------------------- | ----------------- | ------------ |
| Offline-only                     | `bash scripts/test.sh --no-smoke`                                | No                | repo, domain |
| All (offline + smoke + semantic) | `bash scripts/test.sh --port=N`                                  | Yes               | —            |
| Agents blackbox                  | `cd agents && python scripts/run_blackbox_tests.py [domain]`     | No                | domain       |
| Backend structural               | `cd back-end && npx tsx src/tests/structural/layer-deps.test.ts` | No                | —            |
| Backend blackbox                 | `cd back-end && bash scripts/run-blackbox-tests.sh [domain]`     | No (self-manages) | domain       |
| Frontend blackbox                | `cd front-end && bash scripts/run-blackbox-tests.sh [domain]`    | No                | domain       |
| Predeploy benchmarks             | `bash scripts/run-predeploy-local`                               | No (self-manages) | selector     |
| Backend ESLint                   | `cd back-end && npm run lint`                                    | No                | —            |
| Frontend ESLint                  | `cd front-end && npm run lint`                                   | No                | —            |

## Per-Package Commands

```bash
cd back-end && npm run test:api                  # backend API blackbox domains (benchmarks, data, data-grep, ...)
cd back-end && npm run test:coverage             # backend coverage, enforces back-end/.c8rc.json (:report = no threshold)
cd front-end && npm run test                     # frontend vitest (blackbox + structural)
cd front-end && npm run test:coverage            # enforces front-end/vitest.config.ts thresholds (:report = verbose, no threshold)
cd agents && bash scripts/run-coverage.sh        # agents coverage, enforces fail_under (--report, --html for htmlcov/)
cd agents && python tests/e2e/run_e2e_tests.py --basic   # E2E: spawns real agents through a running backend
cd mac-app && npm run test                       # macOS only; also test:coverage[:report], scripts/run-blackbox-tests.sh <domain>
source agents/venv/bin/activate && python3 scripts/run-deploy-structural-gates.py [--max-workers N]
```

`run-deploy-structural-gates.py` runs the whole deploy structural registry with a CPU-scaled default concurrency (at most 8); `--max-workers` never changes benchmark fleet width. Activate the venv first so its `bin` precedes Homebrew on `PATH`; otherwise child `python3` lacks the agent dependencies.

## Running Services Directly

Without `scripts/run.sh` (no ngrok or secrets): backend `cd back-end && PORT=<N> npx tsx watch src/bootstrap.ts`, frontend `cd front-end && npx vite --port <N+1>`. In dev the frontend assumes the backend is on its own port minus one (`front-end/src/lib/backendUrl.ts`) unless `VITE_BACKEND_API_URL` is non-default, matching `run.sh` (backend = base, frontend = base + 1); the backend's `ALLOWED_ORIGINS` must include the frontend origin. Export the same unique `TEMPORAL_TASK_QUEUE` for backend and worker.

## Live-Account Prerequisites

These fail on third-party configuration, which RCA Step 4 says to surface, not mask:

- The Codex E2B backend blackbox domain and all smoke benchmarks need working OpenAI compute (a leased token or funded credits) plus OpenRouter access to the `rose-1-ultra` waterfall models.
- `admin-health` needs Amplitude and admin-Stripe credentials; `agentcard` needs `AGENTCARD_PUBLIC_URL`.
- The agents `benchmark` blackbox domain replays real Blue Bottle LLM judges, and full agents coverage needs the complete authoritative env plus outbound access (HTTP capture does not mock live responses).
- On Andy's Mac, run that full suite natively when an isolated Linux container lacks these prerequisites; keep Linux runs for the cloud controller and platform-specific regressions.

## Suite Details

### Agents Blackbox (`agents/tests/blackbox/`)

Python tests that exercise agent tools (web_search, send_sms, etc.) with mocked HTTP boundaries via `httpx_capture`. No backend or external services needed.

```bash
cd agents && python scripts/run_blackbox_tests.py              # all domains
cd agents && python scripts/run_blackbox_tests.py web-search    # single domain
cd agents && python scripts/run_blackbox_tests.py --list        # list domains
```

Agents coverage runs each blackbox domain in its own bounded interpreter and
then combines coverage before DEMO cache and unit checks:

```bash
cd agents && bash scripts/run-coverage.sh
```

Its runner control checks two bounded native lanes, ordered result reporting,
cancellation drain and exited-parent descendant cleanup. The terminal-evidence
fixtures share one 60-second deadline across two isolated pytest groups; never
raise that limit or omit targets to hide serial waits.

`AGENTS_COVERAGE_DOMAIN_TIMEOUT` sets the whole verification-domain budget in
seconds (default 1800, positive integer). A large domain includes many individual
checks and shares the host with the other coverage pools. Timeout and cancellation
still fail the domain and retire its owned process group. This infrastructure
budget does not change benchmark task execution or allocation-to-release deadlines.

For mock deadline cases, use the existing deterministic clock and wait controls
at the owning request or stream boundary. Preserve the production budgets and
endstate assertions; a few milliseconds of real host scheduling is not a stable
mock contract. Hermetic shell fixtures must expose the existing bounded tools
that the production command uses, including `timeout` when their reduced PATH
would otherwise hide it.

### Backend Structural (`back-end/src/tests/structural/`)

Architecture invariant tests — import direction, cross-domain isolation, provider boundaries, Prisma/Express encapsulation. Fast, no server needed.

```bash
cd back-end && npm run test:structural
```

### Backend Blackbox (`back-end/src/tests/blackbox/`)

TypeScript tests that exercise backend API endpoints. The runner script auto-starts an isolated backend on a dedicated port — no manual server setup needed.

```bash
cd back-end && npm run test:blackbox                # all domains
cd back-end && bash scripts/run-blackbox-tests.sh auth  # single domain
```

The runner needs a local Postgres: it uses the workspace's
`victoria-db-<workspace>` Docker container (start it with `docker start
victoria-db-<workspace>`) and falls back to system PostgreSQL on Linux, always
in its own `victoria_<workspace>` database, never the shared `victoria`.

When a Fly machine hosts local backend tests, remove its production identity
from the test child before imports: `env -u FLY_APP_NAME npm run test:coverage`.
The dump writer intentionally disables local files whenever that variable is
defined, even as an empty string. Keep the parent controller's Fly identity for
ownership checks. Use the complete authoritative env and a private
`CODEX_AUTH_PATH` when the local Codex credential is fresher than the seeded
integration; the existing runner imports it into the isolated database. Set
`E2B_CODEX_CODE_TEMPLATE_ID` to the template being used and verify that its
matching `e2b-templates/<template-id>/ws-server.mjs` exists and is applied.
These local test settings do not propagate credentials to separate cloud
benchmark guests.

Keep the prescribed test concurrency and provision enough host memory for
Postgres plus simultaneous Node coverage processes. A successful isolated
domain does not prove that the full coverage workload fits. Check kernel OOM
and Postgres recovery evidence after a lost database connection. After any test
runner exits, verify that its owned backend descendants and listener also
retired before reusing the database or ports.

### Frontend Blackbox (`front-end/src/tests/blackbox/`)

Vitest-based tests that exercise frontend components and logic in jsdom.

```bash
cd front-end && bash scripts/run-blackbox-tests.sh              # all domains
cd front-end && bash scripts/run-blackbox-tests.sh terminal      # single domain
```

### Browser and Semantic Tests

- Install the browser once inside the activated agents venv before browser blackbox tests: `python -m playwright install chromium`.
- Semantic readiness checks session state and visible behavior; never add a network-idle prerequisite to the realtime app's authenticated test helper.
- To diagnose a silent startup recurrence, set a temporary `NODE_DEBUG=esm` with all output redirected to private `.context` artifacts, and keep those diagnostics out of Git.

### Smoke Benchmarks (`agents/benchmarks/`)

Rose root-agent execution has a separate 120-minute wall-clock backstop, including Polar
tasks whose normal budget is browser steps. For a deliberately bounded test run,
set `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300` on the launcher. Local and cloud
Rose agent runs then pause work five minutes after root creation even if they are
still progressing, including time spent preparing attachments and realtime capture.
Existing shorter task timeouts and browser-step budgets still apply. Provisioning,
evaluator work, evidence collection and verified teardown have their own bounds;
they must finish rather than be cut off with a process kill. This setting does
not change catalog prompts, task timeouts or grading criteria. Cloud `--timeout`
controls the controller watchdog and is not a substitute for this execution cap.

Long cloud fleet proofs need a continuously running controller host as well as
cloud benchmark guests. Run the controller, status proxies, Hub, collectors and
evidence publishers on the same persistent Linux host. Detaching a process or
using macOS `caffeinate` does not prevent clamshell sleep from suspending local
inventory publication and collection. On a Mac, `caffeinate -is` stops idle sleep but
closing the lid on battery still suspends the controller and local WebSockets
while cloud tasks continue; check `pmset -g log` before treating a long
wall-clock gap as a provider timeout. Preserve that host's real checkout,
hostname and ownership records for exact recovery; copying a live owner's
`.git` records to another host does not transfer recovery authority.
Set `TZ=UTC` before detaching the controller and keep it for recovery, so legacy
`ps lstart` ownership strings are rendered consistently. Do not rewrite an
existing ownership record to work around a timezone change.

At ten-bench width, a Fly-hosted controller needs dedicated performance CPU
(at least `performance-2x` with 8 GB RAM). A `shared-cpu-4x`/8 GB controller
showed about 92% CPU steal while running ten stacks and their data-plane
proxies: the same app-wide Fly inventory call completed in about 2 seconds from
an external host but exceeded 90 seconds on the controller, invalidating the
autoscalers. Check the controller VM shape before the proof and sample
`/proc/stat` steal when inventory refreshes lag. Change its VM shape only after
the active fleet's exact ownership and evidence are closed; restarting a live
controller does not transfer its cleanup authority. This requirement is for
the controller, not a change to benchmark guest, harness, prompt or grading.

Cloud bench volumes fork from one complete warm-donor snapshot. Snapshot
creation is a dependency-refresh operation, not a per-bench upload. Each bench
still needs its own isolated restored volume, and those restores run in
parallel within a slice. Avoid recopying a large donor or refreshing its
snapshot unless dependency manifests or the donor contents actually changed.

Current LIVE acceptance is documented in the Operations Runbook's **Current width-fifty LIVE
acceptance** subsection: five consecutive runs of fifty distinct random eligible
DAILY tasks, temporary 1,200-second execution per task and hard 5,400-second
image-build-start through final durable publication/native release per run.
Use the normal uncached image build/activation, then the normal CLI with fifty
concrete names and `--retry-infra 1 --concurrency 50 --strict-barrier
--e2e-timeout 5400 --e2e-started-at <original-image-epoch>`. One released and
published INFRA attempt may be retried without restarting healthy peers or either
clock; retain every physical attempt in its original logical group. Genuine
task FAIL remains valid and is not retried. Keep LIVE autoscale maximum
15, scoped native admission, exact-handle monitoring and grouped
early task verdicts. Intermediate observations warn/retry; usable stage handoffs
and the whole-run limit remain authoritative. Compare generous fixed historical
LIVE stage targets and avoid paid deploy overlap with accepted LIVE latency.
The prior original hundred-task campaign is complete and is not restarted.

PR #1299's original user-authorized acceptance was ten consecutive slices of ten
distinct daily/Polar tasks. Each benchmark needs meaningful real provider
execution, a genuine terminal `PASSED` or `FAILED`, and exact owned-resource
release within one 1,800-second allocation-to-finish deadline. Normally expect
more than three LLM calls when sensible; chat, early terminal results and an
execution-window `FAILED` can need fewer. Do not force calls, alter tasks or
count cache-only replay, queued requests or a Rose start alone as execution.
Use `scripts/verify_successful_llm_queries.py --diagnostics-only` to retain strict
query findings as diagnostics. Recovered LLM/browser/save/persistence errors and
intermediate elapsed timings are warnings. Missing execution, a missing terminal
result, an E2E cutoff breach or lingering resources break the streak; later
recovery does not retroactively grant credit. Inspect the actual terminal
trajectory and exact cleanup once. Retain original artifacts; FE/LLM publication
is best effort after resource release and does not block the next slice.
Publishers must retire before final cleanup. Report whole-slice and individual
benchmark E2E times, with task durations where available. The 20-minute target
is a warning and speedup reviews are waived. Preserve 7,200/300/1,800-second
normal execution, temporary execution and E2E budgets. The earlier follow-up
50-task command is explicitly authorized to use 600 seconds temporarily; this
does not change normal defaults or the 1,800-second allocation cutoff. A runtime change that
invalidates earlier runs starts a fresh streak; test/doc-only changes can carry
results when their exercised inputs are verified unchanged.

The existing `scripts/tests/publish_evidence_links_browser_validation.test.sh`
also covers transcript ownership, literal versus Markdown bubbles, adjacent
delimiter runs, inline code, entities, links, escapes and line boundaries. Run it
with the agents venv active so it uses the existing `markdown-it-py` dependency.
These compact offline controls complement the real fresh-browser publication
check; they do not supply fleet acceptance credit.

End-to-end tests that spawn real agents against a running backend. Requires all services (back-end + agents + research) to be running.

```bash
bash scripts/run-predeploy-local
```

This gate selects the bounded predeploy set and invokes `scripts/run-bench --local`, which owns the stack, execution and cleanup. General cloud selections use `scripts/run-bench <slice-or-task...>`. The lower-level `run_benchmark.py --port N` remains available for an explicitly reused running backend; it is not the normal deploy launcher. Production-only payment verification uses `scripts/run-bench agent-payment-production-abandonment` and the CLI's existing production routing.

The user-approved AgentCard closed-card release stall is automatically skippable
in every future sandbox and production run, including CI and `/deploy`; no flag
or renewed approval is required. A confirmed CLOSED/zero-balance card with its
exact transfer still consumed/released0 and funding RECLAIMING produces a loud
`SKIPPED` warning. Independent lifecycle and execution cleanup failures remain
strict. Retain the unreleased allocation and pending refund as liabilities;
the skip does not prove native release. Explicitly set
`BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=0` only for strict release diagnostics.
The benchmark blackbox domain owns the saved production-receipt regression.

Every `/deploy` also runs compact offline benchmark controls in Step 4s:
canonical CLI dispatch, completed LIVE-query evidence, exact composite-root
cleanup, quiesced resource retirement, and evaluated result publication before
teardown. The live-result control exercises the actual fleet projection/Hub
transport, exact-owner publication acknowledgment, task runner's agent/phone
cleanup boundaries, and serialized worker
admission after unknown inventory observations, without model calls. Frontend
blackbox coverage pins live pass/fail polling and stops detail polling once the
run is terminal. The CLI control covers a single
50-task dispatch with the requested five-minute execution setting and existing
production-only routing. `run-deploy-structural-gates.test.py` prevents those
controls from disappearing from the automatic registry. They are also registered
in `scripts/test.sh`; no live 50-task campaign is added to deploy by default.

## Database Migrations

Every `schema.prisma` change ships `back-end/prisma/migrations/<timestamp>_<name>/migration.sql`; local setup pushes the schema, so tests pass without one while prod `migrate deploy` fails (`back-end/src/tests/structural/migration-drift.test.ts` checks both directions). The authoring recipe (`migrate diff` against the local database, then `npm run prisma:push:local`) and the squashed `00000000000000_init` baseline are in `back-end/CLAUDE.md`.

## Deploy Gates: Blacksmith and CI

- `scripts/deploy gates` (`scripts/deploy_gates.py`) selects whole gate categories with `scripts/deploy_test_plan.py` (`--list-selected` prints them; gate names, commands and `cwd` are in its `standard_template()`). Quick checks (format, ESLint, TypeScript, backend structural) run on the coordinator.
- With the default `--executor blacksmith`, every other selected gate gets its own Blacksmith VM sized by `BLACKSMITH_RUNNERS` (2-16 vCPU): `scripts/deploy_test_github.py` pushes an annotated `deploy-gates/<N>vcpu/<gate>-<token>` tag carrying the request, and `.github/workflows/deploy-gates.yml` checks it out from a sticky-disk git mirror, unpacks the `DEPLOY_GATE_ENV_BUNDLE` secret (re-set it when the env files change) and runs the unchanged `deploy_test_worker.py` / `deploy_test_backend.py`.
- Results come back over R2 (`deploy-gates/v1/<tag>/started.json` and `done.json` in the trace bucket) because all of this user's tokens share one 5,000/h GitHub REST quota; never poll the REST API in a loop. A hung VM gate shows only `started.json`: cancel its Actions run, then read the job log.
- `smoke` (including the AgentCard lifecycle tasks) runs on the Fly cloudbench fleet through `scripts/deploy_test_cloud.py`; `--executor local` runs every gate in a linked worktree on this host instead (capped by `--structural-workers` and `--semantic-worker-processes`).
- To run one failing gate alone, run its template command in its `cwd` (e.g. `cd agents && bash scripts/run-coverage.sh` or `bash scripts/run-deploy-semantic-stack.sh`). That is repair evidence only: the staged cycle in `docs/deploy-test-cycle.md` (`focus`, then the full failed gates, then all selected gates) still has to pass. If a gate passes locally but fails on Blacksmith, diff the host first (users, `/proc` readability, git config, interpreter build).
- Other workflows, all on Blacksmith runners: `deploy-agents.yml` deploys Fly workers for agents changes on main (also every 10 minutes and by `expected_sha` dispatch); `prebuild-agents-image.yml` prebuilds the agents image for PRs; `auto-tag-mac-app.yml` tags a Mac release when a main merge changes the shipped Mac surface and `release-mac-app.yml` builds `v*` tags on macOS; `chat-lifecycle-ratchet.yml` is the production semantic frontend gate on deployments; `claude-code-review-fallback.yml`, `deploy-fly-log-shipper.yml` and `download-egress.yml` cover review fallback, the log shipper and Mac download health.

## Adding New Tests

- **Backend API endpoint:** Add `back-end/src/tests/blackbox/<domain>.blackbox.ts`
- **Agent tool:** Add `agents/tests/blackbox/<tool-name>/test_<tool-name>.py`
- **Frontend component:** Add `front-end/src/tests/blackbox/<domain>.blackbox.tsx`
- Deploy-gate fixtures allow 60 seconds for startup/cleanup observations and assert actual terminal state, exact resource release and real failures; simulated review deadlines use a controlled clock so host load cannot change the scenario.
- A native process-observation timeout is a read failure, not proof of a leak or absence: re-observe within the owning gate and require positive parent/group/state evidence before cleanup.
- Teardown fixtures include the runner's early EXIT-trap setup and distinguish an executing child from an unreaped terminal child.
- Correlate timing diagnostics with the measured operation (a router-stream clock excludes later database or Temporal completion); warn on inner elapsed observations and keep the outcome, ownership and end-to-end checks.

The compact live-result deploy control also owns native inert worker admission,
cancellation between stages and clone retries, exact prelaunch retirement,
launched-worker capture failures, and the decoded-size Hub transport boundary.
Frontend coverage follows every phase through release; backend Hub round-trip
coverage preserves those fields. The original full forensic bundle is unchanged;
Hub transport omits duplicated diagnostic logs while keeping complete transcripts.
Generic failed-owner archive readiness has a separate `archive-verified.json`
receipt with `native_release_verified=false` and zero proof credit. Follow
the supported exact-owner CLI recovery in
`agents/benchmarks/README.md`'s Operations Runbook through its unchanged final
native provider audit; archive readiness alone is not resource release.
