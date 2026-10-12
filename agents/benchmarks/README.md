# Agent Benchmark Harness

Spawns real agents against prod or localhost, polls for completion, evaluates pass/fail, handles approvals, retries transient failures, and stores results.

## Eval Suite (the ONE catalog)

`tasks.json` contains the ordinary suites, and the sibling `polar_tasks.json` contains Polar tasks. The shared catalog loader combines both for selection (see CLAUDE.md "Eval Suite"). Each entry carries the additive eval contract — `status` (`ready` | `incomplete`), `runner` (`agent`), `bench` (`pipeline-e2e` harness plumbing | `rose-bench` harness-independent capability), `description`, `environment`, `evaluators[]`, `source` — validated by `long_horizon.py:validate_catalog()`. Idea kernels live in `long_horizon_ideas.json`.

**How evaluators pass/fail** (Layer 1 harness contract → Layer 2 `evaluators[]`,
tree-aware semantic evidence, Blue Bottle worked example): see the `/benchmark`
skill at `.claude/commands/benchmark.md` → **Evaluators**.

```bash
# From the repository root: every ready benchmark eval on an isolated local stack
scripts/run-bench eval

# Print the holding set (ready vs incomplete)
scripts/run-bench eval --list

# Run a named subset
scripts/run-bench eval --only test-mass-agent-run-0,browser-agent

# Run one bench axis
scripts/run-bench eval --bench rose-bench
```

Every task runs on a **base-image fixture**: undeclared environments inherit `base:victoria-prod-sync-v1` (workspace prod-sync DB, `scripts/setup-db.sh`) at load time — registry + pg_dump freezer in `fixtures.py`. Every completed run — pass or fail — is recorded: full record in `runs/*.json`, one line per attempt in `history/task_attempts.jsonl` (`record_attempt`), full LLM trajectories in `.llm-dumps/<agent_id>/` (always-on locally).

### Live data fixtures (`environment.live_fixtures`)

`db_fixtures` are _frozen_ task deltas on a base image (reproducible). The single **`live` fixture** is the opposite: an explicit prod-synced overlay for credentials that must be current at runtime. It includes compute tokens, browser context/provider profiles, cookies and origin storage, passwords, passkeys, `CookieBundle` rows, and `SteelSessionAuth` rows. A frozen expired token is worthless, so tasks that need current credentials declare the overlay explicitly.

Declare it only on tasks that exercise current credentials:

```jsonc
"environment": {
  "mode": "live",
  "live_fixtures": ["live"]
}
```

- **`live`** — syncs fresh compute tokens plus the browser-auth graph from production (`seed-local.ts --compute-tokens-only` and `--credentials-only`). Tasks with `environment.live_cookie_domains` scope every domain-bearing browser-auth table to those domains; tasks without it retain the complete account-wide graph. In simulator mode the overlay is skipped as a unit because environment-boundary tools are simulated.
- Omitted `live_fixtures` resolve to `[]`; using a live website does not implicitly import production credentials.
- Site-specific setup is task scenario logic, not another live fixture. For example, the Amazon passkey probe applies `live`, then temporarily removes competing cookie/password paths and restores them in cleanup.

Validated by `long_horizon.py:_validate_environment`: the only accepted fixture name is `live`, and synthetic tasks cannot declare it.

Task-specific DB deltas remain separate from the base image. The dedicated gate-user deltas are safe to pre-seed physically, but their declarations remain useful for reset/isolation. Plaid and user-data deltas use the regular benchmark user and must not be bundled into the shared base image because they would contaminate unrelated tasks.

Suite selection (`run_benchmark.py --suite ...`) runs only `status: "ready"` benchmark entries; explicit `--task <name>` still targets incomplete agent evals for dev iteration. **Never rename an existing task `name`** — it is the primary key into `history/task_durations.jsonl` (success ledger), `history/span_durations.jsonl` (p99 baselines), and `runs/*.json`; a rename orphans that history (guarded by `test_history_ledger_task_names_still_exist_in_catalog`). The FE dev query box reads this same catalog via `GET /api/benchmarks/test-prompts`.

## Quick Start

Every detached launcher prints the private log and exact controller exit marker.
The controller log prints `scripts/run-bench monitor <run-directory>` for its
own run. Poll that command every 30 seconds; its `--controller-status` marker
reports the actual controller exit independently of card freshness and cleanup.
Follow CLAUDE.md's "Monitor every cloud launch" guidance through resource release.

Standard boot-launched REAL tasks use fresh volumes for both primaries and
workers, with verified image dependencies, an authenticated exact-ref Git
checkout and the same canonical isolated database fixture. SIM tasks and
`--sim-on` keep snapshots and World Model assets. Use `--snapshot-volumes` for
a restore diagnostic; generic `--provision-pool` and legacy startup retain
their snapshot path. Source-only bootstrap changes reuse the verified image.
Continue monitoring through exact resource release: an accepted delete plus an
exact owned-volume `pending_destroy` or `destroyed` terminal receipt qualifies
release even when the provider retains that object; request acceptance alone
does not.

For the current user-requested five consecutive LIVE DAILY runs of fifty,
follow CLAUDE.md's **Current width-fifty LIVE acceptance** subsection. Each run
uses fifty distinct randomly selected eligible names through the normal CLI
with `--retry-infra 1 --concurrency 50 --strict-barrier`, temporary execution
1,200 seconds and `--e2e-timeout 5400 --e2e-started-at <original-image-epoch>`.
The 90-minute clock includes all attempts, durable publication and full release.
Only infrastructure failures get one fresh isolated retry, after the prior
attempt releases resources and publishes its terminal result. Genuine task
FAIL remains valid. Keep every attempt visible within its original group;
healthy peers continue and neither clock resets.
Use a fresh benign comment/ref plus the normal `image-build --no-cache` and
exact-image activation every trial. LIVE autoscale remains 15; the cached mass
profile's maximum 2 and allocation deadline do not apply. Keep the original
hundred-task result complete, exact thirty-second monitoring, grouped early
verdicts, generous fixed historical LIVE stage targets and no paid deploy overlap
with accepted LIVE latency. The existing stability wrapper's width-32 cap does
not restrict this ordinary fleet; do not substitute smaller slices.

Ordinary source-only runs reuse verified dependency images and completed
snapshots. Before an image-build-to-fleet measurement, complete CLAUDE.md's
**Fresh clone setup (Andy’s Mac)** dependency reuse and actual backend seed-cache
import check before recording the image clock. An image-only publication needs
no backend dependency check. For an explicitly requested cold build/push
measurement, use
`scripts/run-bench image-build --builder depot --no-cache --build-context <checkout> --out-dir <private-output>`
from the repository root. The selected checkout supplies both Dockerfile and
Fly config; the private receipt records pre-launch source/dirty status and
recipe/config hashes, not artifact equivalence. The shared final-layer installer
joins unchanged npm/Prisma and Python installs concurrently and retains installed
dependencies and home assets except npm download caches/logs.
`image-build` defaults to Fly-integrated Depot with app scope, zstd level 3 and
`linux/amd64`; `--builder native` remains an explicit diagnostic. Its receipt
records those requested options. Independent `807edee9f` no-cache build/push completed
in 493.6 seconds in one attempt, excluding activation/fleet startup. Activate the
exact receipt image and verify guest digest/runtime consumption before the cohort.
The successful receipt's `image_ref` includes the verified registry digest. The
publisher reads the exact tag and digest through the registry before handing it
to activation. If an acknowledged manifest is missing, it republishes only
manifest bytes matching the original build's digest, then verifies that same
handoff. This continuation uploads no layers and repeats no dependency build;
unverified output stops the image stage with its private observations retained.
Image publication automatically caches a checksum-verified pinned Fly client in
the Git common directory. Native publishing uses child-only classic Docker over
HTTPS (`DOCKER_BUILDKIT=0`, `--wg=false`); shared Fly/PATH and the benchmark
runtime remain unchanged. A tiny CLI control took 31.6 seconds including client
installation and push; it is not a full cold-image measurement. No manual
download is needed for fresh worktrees.

The existing recorded mass-demo cache diagnostic uses:

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

An exact fresh infra canary canceled during database/dependency bootstrap may
have no service PID ledger, backend log, or driver cleanup ACK. Preserve its
stopped Machine and volume while capturing the original files through an inert
boot and restoring its exact original config. This is a pre-service case:
`run.sh` and an isolated database may already have run. The archival validator
binds the original owner/slot, complete logs, missing service files, immutable
clean checkout and every native injected executable to the captured source
recipe. The exact source commit must be available in the owning workspace's
Git objects. This recovery path supports clean committed recipes with no
worktree patch; uncommitted or unsealed recipes fail closed. Its current stopped
Machine/attached-volume config must still
match. Before publication, an independent reviewer records the exact source
ref, computed recipe hash and reviewed pre-service phases in
`source-boundary-reviewed.safe.json` alongside the capture. This is causal
source review, not permission to grant benchmark credit:

```bash
python3 scripts/cloudbench-prestack-recovery.py \
  --registry <absolute-exact-owner-directory> --bench <exact-canary-task> \
  --capture-dir <absolute-private-original-capture-directory> \
  --machines-json <private-current-native-Machines-json> \
  --volumes-json <private-current-native-volumes-json> --publish
scripts/run-bench --recover-stale-owner <exact-owner-token>
```

The capture directory retains `<machine>.originals.private.tar.gz`,
`<machine>.provenance.safe.json`, and `<machine>.original-config.private.json`.
The distinct `guest-bootstrap.confirmed` receipt reports isolated DB creation,
zero provider allocation and zero benchmark credit. It creates no standard
provider manifest or guest shutdown ACK. Exact recovery rechecks the original
capture and fresh native inventory before its existing fresh-resource reaper;
unreviewed source recipes, service launch, incomplete capture and foreign owners
stay quarantined. A genuine pre-stack cancellation also requires its original
cleanup ACK and proven stack-log absence; index-bootstrap cancellation retains
its own source/absence checks. Older captures without the full immutable input
binding are not silently accepted. The quick bootstrap and existing prestack
controls run in the ordinary deploy process. Continue monitoring through exact
Machine/volume release.

For generic failed-owner recovery, `_forensic/archive-verified.json` preserves
complete originals with `native_release_verified=false` and zero proof credit.
Continue `scripts/run-bench --recover-stale-owner <exact-owner-token>` through
its exact resource reaper and final native provider audit. Archive readiness is
not release; follow CLAUDE.md's recovery guidance instead of calling the archive
verifier directly. Other forensic receipt modes keep their existing contracts.

For an explicit cold-image measurement, activate the exact image from its build receipt before the fleet:

```bash
scripts/run-bench image-build --builder depot --no-cache --build-context <committed-checkout> --out-dir .context/image-build
benchmark_image_ref=$(python3 -c 'import json; print(json.load(open(".context/image-build/cloudbench-image-build.json"))["image_ref"])')
scripts/run-bench image-activate "$benchmark_image_ref" --ref "$(git rev-parse HEAD)" --out-dir .context/image-activation
```

`image-activate` uses the existing app environment lock and owned warm-source setup. It strictly stops the exact existing donor before environment activation, activates the published image on the donor and this workspace's stopped pool members, synchronizes the requested Git ref, and parks the donor. It sets the existing prebuilt-image selection internally, so it does not build again. Confirm guest image digests in the ensuing fleet's native inventory. Source-only branch runs normally reuse verified dependencies and need no image build or activation.

Repeated concurrent cloud campaigns share one parent-owned Machines/Volumes inventory feed. Borrowers retain the same keyed generation and never stop the publisher; capacity admission and exact resource teardown checks stay native. A standalone fleet and production-only campaigns keep their existing paths.

For this explicitly requested 50-copy cached stress run, use the command-scoped
Machine ceiling of 138 and `--autoscale-max 2`: the current 36 existing app
Machines plus 50 primaries, up to 50 optional autoscaler workers and two transient
slots. Inspect native app inventory and headroom again before a future run;
ordinary ceiling 56 cannot hold this current cohort, and ceiling 88 leaves only
two worker slots. This profile creates no idle resources and changes no default
ceiling, shared-CPU governor or production headroom. `--strict-barrier` keeps all
50 copies in one ready cohort; controller occupancy does not prove execution overlap.

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

This launches 50 independent one-task controllers, each with the unchanged 50
first-level general-purpose children: 2,500, with existing explore allowances unchanged,
not 50 distinct tasks. Task-agent replay is read-only and refuses live fallback
on misses or unresolved context. The separate harness keeps genuine declared
evaluation; LLM judges may call providers. Existing cold-terminal passthrough
is not a recorded hit, and cached diagnostics earn zero LIVE acceptance credit.
Keep tasks, prompts and evaluators unchanged and follow the printed monitor command.
These compact regression controls run in the existing deploy gate; large cached
campaigns remain explicitly requested experiments.
Repeated `--strict-barrier` campaigns wait for every surviving eligible copy’s
unchanged stack and autoscaler readiness before releasing each bounded cohort.
An ordinary terminal member failure stays failed while healthy peers and later
cohorts continue. Preserve the original requested count alongside released and
failed counts; partial release never earns full-width credit. Shared publisher
or parent loss, invalid readiness ownership or release membership, and explicit
cancellation retain owned abort handling. Ordinary non-strict sliding scheduling
remains unchanged. Measure execution overlap from task start/terminal intervals rather
than the campaign’s active controller count.

The controller regression command is `bash scripts/tests/cloudbench-multi-workstream.test.sh`.
It requires native Linux for the real worker supervisor’s subreaping proof. On Mac,
the command snapshots tracked scripts and the five real helper modules into private
artifacts, then runs the same fixture with read-only source mounts and no container
network. Its small committed Docker recipe pins Python3.11.9 and Node22.13.0; the
recipe fingerprint selects a reusable local image. Set
`CLOUDBENCH_CONTROLLER_TEST_IMAGE` only to an existing local image that passes the
same platform/toolchain check. Cancellation verifies the exact container’s ID,
unique owner label and source mounts before stopping it. The quick dispatcher
controls are always included in the deploy structural gate.

The daily `agent-payment-new-user-journey` task exercises an isolated, fresh
non-admin account from exhausted free credit through a real Stripe **test-mode**
subscription Checkout, subscription-gate resolution, payment-card approval,
test-portal order confirmation, and backend settlement. Its evaluator requires
the subscription gate before the payment approval, a `tp_` order ID from the
portal, and exact $43.96 purchase, hold, wallet-funding, and AgentCard transfer
records. The harness completes the hosted test Checkout and delivers the signed
session webhook to the isolated backend; it does not seed a subscription or
payment method. Run it with `scripts/run-bench --local
agent-payment-new-user-journey` from the repo root. It requires the Stripe test
secret and webhook secret plus sandbox AgentCard org credentials listed in the
task contract.

```bash
cd agents

# List all benchmark tasks through the supported entrypoint
../scripts/run-bench list

# Run one isolated cloud task
../scripts/run-bench chat-mode --wait

# Run the daily suite as one fully parallel isolated cloud fleet
../scripts/run-bench daily

# Run the selected deploy benchmarks through the isolated local stack
../scripts/run-predeploy-local

# Run an isolated local task
../scripts/run-bench --local chat-mode

# Run a benchmark until root message index 42, export a source, and create a paused checkpoint
../scripts/run-bench --local chat-mode --checkpoint 42 --checkpoint-no-start

# Resume that paused checkpoint later
../scripts/run-bench --local chat-mode \
  --checkpoint-start-agent-id <agent-id> \
  --checkpoint-manifest .context/benchmarks/<run-id>/checkpoints/chat-mode.json

# Compare two runs
python benchmarks/run_benchmark.py --compare runs/A.json runs/B.json
```

Concurrent local selections that mix an AgentCard setup reset with another
payment setup writer receive one owned stack per task. The existing concurrency,
exclusive-first phase, SMS ordering, user identity, and cohort configuration are
preserved. `.context/benchmarks/<run-id>-worlds/local-worlds.json` records each
child's identity, private log, result paths, and cleanup status. The coordinator
confirms ownership before any child allocates services and waits for canonical
agent and stack cleanup before accepting its result. Separate local databases
do not isolate externally shared AgentCard cardholders.

`scripts/run-bench --local <task> --checkpoint <turn_n>` uses the normal local benchmark
orchestrator: it starts an isolated stack, runs the selected benchmark with its
usual fixtures/attachments until the root transcript contains that message index,
pauses the source agent, exports root/tree checkpoint JSON, clones that exported
state, starts the workflow at `execute_dag_resume`, polls the normal benchmark
evaluator, and validates post-checkpoint reasoning-row hygiene.
For `test-mass-agent-run-0`, the runner also enforces the expected post-fanout
visible-card sequence. Use `--checkpoint-no-start` to leave a paused workflow
open in the local FE; the runner keeps that isolated stack alive and prints the
resume command. To reuse a pre-existing export instead of generating one, pass
`--checkpoint-source-json`; optional tree cloning uses `--checkpoint-tree-json`.

## Suites (tags)

The curated tag vocabulary (each task carries zero or more):

| Tag                 | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `antibot`           | Bot-challenge / biometric-defeat browser tasks                          |
| `attachments`       | Tasks with file attachments or document handling                        |
| `auth`              | Tasks needing authenticated sessions (cookie, minted, or anon accounts) |
| `browser`           | Browser agent tasks                                                     |
| `cache`             | Fast-mode cache record/replay tasks                                     |
| `chat`              | Chat mode only                                                          |
| `code-agent`        | Claude Code sandbox tasks                                               |
| `grep`              | User-data grep/search tasks                                             |
| `load-test`         | Mass-agent / scale load tests                                           |
| `outreach`          | Personalized outreach at scale                                          |
| `payment`           | Payment and checkout flows                                              |
| `phone`             | Phone-call tasks                                                        |
| `plaid`             | Plaid-connected finance tasks                                           |
| `polar-bench`       | Odysseys + BU Bench V1 (polar-evals); opt-in suite, never daily         |
| `research`          | Deep-research tasks                                                     |
| `smoke`             | Deploy-gate smoke suite                                                 |
| `social`            | Social-account tasks                                                    |
| `sub-agent-fan-out` | Multi-agent for-each fan-out tasks                                      |
| `transactions`      | Transaction analysis tasks                                              |
| `voice`             | Voice tasks                                                             |
| `wait-for`          | wait_for scheduling tasks                                               |

Special suite selectors (not tags): `all` (every ready first-party agent task;
excludes `polar-bench`), `auth` (cookie-auth task by default, anon tasks with
`--anon` — split by task name), `rose-bench` / `pipeline-e2e` (first-party bench
axis). Run Polar Odysseys + BU Bench V1 with `--suite polar-bench`.

## Tasks

| #   | Name                 | Timeout | Cost Limit | Approval     | Attachment      |
| --- | -------------------- | ------- | ---------- | ------------ | --------------- |
| 1   | chat-mode            | 120s    | 25c        | —            | —               |
| 2   | spawn-sub-agents     | 300s    | 100c       | —            | —               |
| 3   | parallel-tool-calls  | 180s    | 50c        | —            | —               |
| 4   | message-person       | 180s    | 50c        | auto_approve | —               |
| 5   | browser-agent        | 600s    | 200c       | ignore       | —               |
| 6   | claude-code-agent    | 300s    | 100c       | —            | —               |
| 7   | image-handling       | 300s    | 100c       | —            | rs.jpeg         |
| 8   | files-in-sub-agents  | 600s    | 300c       | —            | rs.jpeg         |
| 9   | agent-for-each       | 600s    | 500c       | —            | entities-12.csv |
| 10  | build-boxing-payment | 900s    | 1000c      | prompt_user  | waivers PDFs    |
| 11  | job-applications     | 900s    | 1000c      | prompt_user  | 2x resume PDFs  |

## How It Works

1. **Auth**: Authenticates via Supabase OTP (test account)
2. **Create**: Creates agent via `POST /api/agents` with task-specific config
3. **Attachments**: Uploads test assets via `POST /api/agents/:id/attachments`
4. **Poll**: Every 5s checks agent status, handles approvals, detects stalls
5. **Evaluate**: On terminal status, checks pass criteria (status, tools used, approvals, progress score)
6. **Retry**: On failure, retries once. Pass on retry = transient failure
7. **Save**: Results stored as JSON in `agents/benchmarks/runs/`

## Result Format

```json
{
  "run_id": "uuid",
  "timestamp": "ISO",
  "suite": "basic",
  "base_url": "https://navi-j9a9.onrender.com",
  "summary": {
    "total": 4, "passed": 3, "failed": 1,
    "transient_failures": 1,
    "total_cost_cents": 42.5,
    "total_duration_seconds": 120,
    "pass_rate": 0.75
  },
  "tasks": [{ "name": "...", "passed": true, "agent_id": "...", ... }]
}
```

## Environment Variables

| Variable                | Default                          | Description                                                               |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `BENCHMARK_BASE_URL`    | `https://navi-j9a9.onrender.com` | API base URL                                                              |
| `BACKEND_API_KEY`       | **(required)**                   | API key for authentication                                                |
| `CLICKHOUSE_ENDPOINT`   | —                                | ClickHouse Cloud endpoint for retained Fly.io worker logs (`agents/.env`) |
| `CLICKHOUSE_USER`       | —                                | ClickHouse user for retained Fly.io worker logs (`agents/.env`)           |
| `CLICKHOUSE_PASSWORD`   | —                                | ClickHouse password for retained Fly.io worker logs (`agents/.env`)       |
| `FLY_API_TOKEN`         | —                                | Fly.io deploy token for worker log streaming (`agents/.env`)              |
| `RENDER_API_KEY`        | —                                | Render API key for backend log fetching (`back-end/.env`)                 |
| `SUPABASE_ACCESS_TOKEN` | —                                | Supabase management token for edge function logs (`agents/.env`)          |

## API Endpoint

`GET /api/benchmarks` — Returns all task definitions (no auth required).

## Reviewing Benchmark Logs

Each benchmark run collects production logs from retained ClickHouse rows and live production sources, then stores them in the result JSON under `tasks[].logs`. This is the primary way to debug failing benchmark agents.

### Log Sources

| Source                                  | Key in JSON     | What it captures                                                       | Filtered by                                     |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| **Render** (backend)                    | `backend_logs`  | HTTP requests to/from the API (agent create, status updates, messages) | `agent_id` in URL/body                          |
| **ClickHouse** (retained Fly.io worker) | `worker_logs`   | Agent execution logs retained for 7 days                               | `agent_id` in structlog context or raw JSON     |
| **Fly.io** (live worker stream)         | `worker_logs`   | Live agent execution logs during benchmark runs                        | `agent_id` in structlog context                 |
| **Supabase** (research)                 | `research_logs` | Rose API gateway logs (completions calls, API key validation)          | Time window (no agent_id in edge function logs) |
| **Messages**                            | `messages`      | Full agent conversation transcript (USER/ASSISTANT/TOOL messages)      | Always available                                |

### How to Read Logs from a Run

```bash
# Quick summary: how many logs per source
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for t in data['tasks']:
    logs = t.get('logs', {})
    print(f\"{t['name']}: backend={len(logs.get('backend_logs',[]))}, worker={len(logs.get('worker_logs',[]))}, research={len(logs.get('research_logs',[]))}, messages={len(logs.get('messages',[]))}\")"

# Detailed worker logs (most useful for debugging agent behavior)
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for entry in data['tasks'][0]['logs'].get('worker_logs', []):
    try:
        parsed = json.loads(entry)
        print(f\"[{parsed.get('level','')}] {parsed.get('event','')}\")
    except json.JSONDecodeError:
        print(entry)"

# Full message transcript
python3 -c "
import json
with open('benchmarks/runs/<filename>.json') as f:
    data = json.load(f)
for msg in data['tasks'][0]['logs'].get('messages', []):
    print(f\"[{msg['role']}] {msg['message'][:100]}\")"
```

### Query Retained Worker Logs Directly

```bash
cd agents && source .env

# Logs for one agent
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"

# Recent worker errors
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, level, event, message, raw FROM observability.fly_logs WHERE parseDateTimeBestEffortOrNull(timestamp) > now() - INTERVAL 1 HOUR AND (level IN ('error','exception') OR raw ILIKE '%error%' OR raw ILIKE '%traceback%') ORDER BY ingested_at DESC LIMIT 100 FORMAT JSONEachRow"
```

### How Log Collection Works

- **Render**: REST API call to `api.render.com/v1/logs` with time window, filtered by agent_id
- **ClickHouse**: retained Fly.io worker logs are queried from `observability.fly_logs`, filtered by agent_id, and merged into `worker_logs`
- **Fly.io**: `flyctl logs` streams as a background process for the entire benchmark run, capturing live worker output, then filtered by agent_id after each task completes
- **Supabase**: REST API call to `api.supabase.com/v1/projects/.../analytics/endpoints/logs.all` with time window, filtered for completions-related requests
- **Messages**: Extracted from the agent GET response (always available, no external API needed)

### Token Setup

```bash
# Fly.io (worker logs) — generate a deploy token
flyctl tokens create deploy -a navi-whisper-lux
# Add to agents/.env: FLY_API_TOKEN="<token>"

# ClickHouse (retained worker logs) — values come from ClickHouse Cloud
# Add to agents/.env: CLICKHOUSE_ENDPOINT, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD

# Supabase (research logs) — generate at dashboard
# https://supabase.com/dashboard/account/tokens
# Add to agents/.env: SUPABASE_ACCESS_TOKEN="<token>"

# Render (backend logs) — already in back-end/.env: RENDER_API_KEY
```
