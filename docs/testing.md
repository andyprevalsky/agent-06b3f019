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

| Suite | Command | Server Required | Filtering |
|-------|---------|-----------------|-----------|
| Offline-only | `bash scripts/test.sh --no-smoke` | No | repo, domain |
| All (offline + smoke + semantic) | `bash scripts/test.sh --port=N` | Yes | — |
| Agents blackbox | `cd agents && python scripts/run_blackbox_tests.py [domain]` | No | domain |
| Backend structural | `cd back-end && npx tsx src/tests/structural/layer-deps.test.ts` | No | — |
| Backend blackbox | `cd back-end && bash scripts/run-blackbox-tests.sh [domain]` | No (self-manages) | domain |
| Frontend blackbox | `cd front-end && bash scripts/run-blackbox-tests.sh [domain]` | No | domain |
| Smoke benchmarks | `cd agents && python benchmarks/run_benchmark.py --suite smoke --port=N` | Yes | — |
| Backend ESLint | `cd back-end && npm run lint` | No | — |
| Frontend ESLint | `cd front-end && npm run lint` | No | — |

## Suite Details

### Agents Blackbox (`agents/tests/blackbox/`)

Python tests that exercise agent tools (web_search, send_sms, etc.) with mocked HTTP boundaries via `httpx_capture`. No backend or external services needed.

```bash
cd agents && python scripts/run_blackbox_tests.py              # all domains
cd agents && python scripts/run_blackbox_tests.py web-search    # single domain
cd agents && python scripts/run_blackbox_tests.py --list        # list domains
```

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
inventory publication and collection. Preserve that host's real checkout,
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

PR #1299's infrastructure acceptance is ten consecutive slices of ten actual
benchmarks. Each benchmark must have at least three successful, correlated LLM
provider responses in its own agent tree, a trustworthy native evaluation,
durable evidence and verified teardown. Ordinary benchmark `FAILED` outcomes
are allowed; `SKIPPED`, infrastructure errors and missing results are not.
Attempts, dump-file counts and sibling queries do not establish successful
responses. Do not add calls or alter benchmark behavior to reach the minimum.
Any infrastructure failure breaks the streak; later artifact recovery preserves
diagnostic evidence without turning that failed slice into acceptance credit.
For each valid slice, log elapsed wall time from launch through verified cleanup,
and each bench's elapsed wall time from its exact machine admission through
guest shutdown. Also report the task duration from the sealed run artifact so
provisioning, evaluation, evidence transfer, and teardown remain visible.
The user's October 1 override waives routine speedup reviews when the whole slice
stays within 20 minutes launch-to-durable wall time and every benchmark stays
within 20 minutes allocation-to-durable wall time.
Inspect any spike above that threshold before advancing. Correctness, hidden
infrastructure errors, trajectories, durable evidence and teardown still require
review. The independent 1800-second cancellation cutoff remains unchanged. A code
change starts a new ten-slice streak; do not shorten or change task evaluation to
make this proof pass.

End-to-end tests that spawn real agents against a running backend. Requires all services (back-end + agents + research) to be running.

```bash
cd agents && python benchmarks/run_benchmark.py --suite smoke --port 3001 --ci --parallel
```

The `--port` flag is required for local runs — there is no implicit port default. Use `--prod` to run against production instead.

## Adding New Tests

- **Backend API endpoint:** Add `back-end/src/tests/blackbox/<domain>.blackbox.ts`
- **Agent tool:** Add `agents/tests/blackbox/<tool-name>/test_<tool-name>.py`
- **Frontend component:** Add `front-end/src/tests/blackbox/<domain>.blackbox.tsx`
