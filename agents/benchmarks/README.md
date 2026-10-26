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
- **`live-tamy-identity`** / **`live-aman-food-plan-identity`** — complete credential overlays for a specific production identity (User row + scoped browser auth + compute tokens) that also select that person as the run user. Skipped as a unit in simulator mode.
- **`live-tamy-account-snapshot`** — a prod-synced snapshot of Tamy's *account rows* (User, credits, subscription, integrations, contacts, message history, API keys, blueprints, SMS session, feedback) used as the run's base environment. It is data, not credentials, so it also applies in simulator mode; browser auth is never synced. Used by the long-horizon `raise-5m-rose-labs-brex` bench.
- Omitted `live_fixtures` resolve to `[]`; using a live website does not implicitly import production credentials.
- Site-specific setup is task scenario logic, not another live fixture. For example, the Amazon passkey probe applies `live`, then temporarily removes competing cookie/password paths and restores them in cleanup.

Validated by `long_horizon.py:_validate_environment`: only names registered in `live_fixtures.py` (`LIVE_FIXTURE_NAMES`) are accepted, and synthetic tasks cannot declare any of them.

Task-specific DB deltas remain separate from the base image. The dedicated gate-user deltas are safe to pre-seed physically, but their declarations remain useful for reset/isolation. Plaid and user-data deltas use the regular benchmark user and must not be bundled into the shared base image because they would contaminate unrelated tasks.

Suite selection (`run_benchmark.py --suite ...`) runs only `status: "ready"` benchmark entries; explicit `--task <name>` still targets incomplete agent evals for dev iteration. **Never rename an existing task `name`** — it is the primary key into `history/task_durations.jsonl` (success ledger), `history/span_durations.jsonl` (p99 baselines), and `runs/*.json`; a rename orphans that history (guarded by `test_history_ledger_task_names_still_exist_in_catalog`). The FE dev query box reads this same catalog via `GET /api/benchmarks/test-prompts`.

### Code bench (`code-bench-*`, plan C8)

Seven `rose-bench` code-capability tasks (`deploy_category: "claude-code"`):
Python and JavaScript bug fixes, a feature with tests, a behaviour-preserving
refactor, stack-trace debugging, commit-locally-without-pushing and a front-end
component build. Each fixture lives in `fixtures/code_bench/<id>/` (`repo/`
start state, `hidden/` tests the agent never sees, `reference/` known-good
overlay). `code_bench.py` builds a byte-identical one-commit git archive that is
uploaded as the task attachment; the code agent returns `result.tar.gz` as a
Task Complete file_pointer, and the `code_bench_hidden_tests` static check runs
the visible and hidden tests on it in a scratch copy with a minimal environment.
Only the front-end task adds an LLM judge (`code_bench_screenshot_judge`, one
Chromium screenshot). `code_bench_test.py` proves every grader fails the
unmodified repo and passes the reference; the agents `benchmark` blackbox
domain runs it.

Raw-CLI parity runs the same tasks through Claude Code or Codex directly, with
the template flags, the same model and the same archive, in an isolated CLI
config outside the repository:

```bash
scripts/run-bench code-parity --skip-rose -k 3 --raw-concurrency 2 --out-dir .context/code-bench-parity/raw
scripts/run-bench code-parity --rose-records agents/benchmarks/runs/<r1>.json <r2>.json <r3>.json \
  --raw-results .context/code-bench-parity/raw/parity.json -k 3 --publish-evidence
# or both legs in one command (Rose leg = K sequential --local runs):
scripts/run-bench code-parity --run-rose local -k 3 --raw-concurrency 2 --publish-evidence
```

The report gives per-task x/K, per-run passes, stdev and flaky tasks for each
leg; `parity_ok` is mean(Rose) >= mean(raw) - max(1 task, 5%), and `c8_ok` also
requires both legs to reproduce within that tolerance. Raw-leg credentials are
the template variables (`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`,
`CODEX_AUTH_JSON`/`OPENAI_API_KEY`) or the CLI's managed login. Each attempt
records loaded host hooks/plugins/MCP servers; on boxes.dev devboxes the managed
settings add a SessionStart hook and platform skills to the raw leg.
Without a Claude credential the Rose sandbox routes Claude Code through
OpenRouter's Anthropic gateway; pass `--openrouter-gateway` so the raw leg uses
the same transport and served model (`--lease-claude-token` leases from the
backend pool instead).

INFRA is never a task verdict. A raw attempt whose CLI reports an API error
status (for example 400 "Credit balance is too low") is rerun with
`--raw-results <parity.json> --rerun-infra`. Rose rows that were interrupted or
failed owned cleanup after the local backend died are excluded and rerun
(`--rose-retry-infra`, default 2). On a shared 15 GB devbox the memory watchdog
TERMs the largest workload process, often the local stack's ~2 GB backend; run
the Rose leg in a bounded scope outside the workload slice, for example
`sudo systemd-run --scope -p MemoryHigh=4G --uid=$USER --gid=$USER -- <script>`
with HOME and PATH set in the script.

## Quick Start

### Process Bench and continuous learning

`scripts/run-bench process` (alias `process-bench`) selects exactly ten synthetic
process cases; `scripts/run-bench list` shows their `Process Bench` titles.
`scripts/run-bench eval --bench process-bench` uses the ordinary evaluator
runtime. Cases execute the attached, network-free business fixture in a code
sandbox. Reading fixture data or writing a completion summary is not execution.

Each `process_spec` in `tasks.json` declares versioned steps, exact actor/entity
bindings, prerequisite order, business days, input/output domains, evidence,
conditional branches, forbidden shortcuts, blocked outcomes and final success.
`python -m benchmarks.process_bench` (from `agents/`) rejects invalid graphs,
impossible condition values, evaluator drift and fixture drift; `--write`
regenerates only changed Process Bench evaluator entries. Existing task bytes
are preserved. Catalog loading and canonical evaluation enforce that generated
contract. Native SDK command/result checks precede the existing tree-aware
semantic judge, which receives the original available rows without further tail
truncation. Process checks require the native full event count to match the
retained events. The existing producer caps SDK rows at 200 events; longer or
missing-count histories fail closed before judging rather than hiding a prefix.
The fixture permits incorrect order so the evaluator, rather than the fixture,
must catch skipped work. A successful operation is still insufficient when
substantive input, original scope, handoff or process evidence is missing.

**NEVER FORGET TO LET THE LEARNINGS FLOW.** While developing WHM task1/fundraiser,
carry confirmed failures and fixes into the applicable Process Bench specs,
reusable checks and regression traces; carry Process Bench findings back to
task1. Record immutable source/trace references, preserve original results and
distinguish verified cause from hypothesis. Domain findings affect applicable
cases; general process failures become suite-wide checks. Regenerate evaluators
from the same versioned spec after every case change. Never change obligations
or expected outcomes merely to turn a failed trace green.

The initial sanitized learning ledger is `fixtures/process-learnings.json`.
It cites saved `0ab5620a5` evidence without copying private investor data:
original scope versus weakened subgoals, material handoff, full follow-up
waterfall, valid declined subresults versus settlement, and separate business
and wall clocks. The 25-iteration cap and 1,666.184 seconds in two waits are
observations, not a diagnosed clock bug or a claimed runtime fix. Use a replay
before making that claim. This feature does not change or relaunch task1.

Owning proof: `python -m pytest -q benchmarks/process_bench_test.py`; the same
controls run in the existing `benchmark` blackbox domain and deploy coverage.
They execute real fixture operations with captured native-event envelopes and
mock only the semantic provider boundary. This proves enforcement and complete
judge input, not model judgment accuracy or a live ten-task success rate.
The sanitized `fixtures/process-native-sdk-events.json` also records an actual
E2B success and explicit error-string result, with source/template provenance.
Errors remain failed evidence; numeric exit codes are not inferred from prose.
Original batch result blocks are retained, but association with shared metadata
is unsupported and fails closed. Local writable fixtures are not cryptographic
proof: recorded mutations are rejected and the full semantic evidence remains
required. The learning ledger records these implementation findings separately
from the saved task1 observations, without claiming a task1 cause or fix.

Every detached launcher prints the private log and exact controller exit marker.
The controller log prints `scripts/run-bench monitor <run-directory>` for its
own run. Poll that command every 30 seconds; its `--controller-status` marker
reports the actual controller exit independently of card freshness and cleanup.
Follow the Operations Runbook's "Monitor every cloud launch" guidance (below) through resource release.

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
follow the Operations Runbook's **Current width-fifty LIVE acceptance** subsection. Each run
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

A post-service fresh or pool guest that stopped before sealing runtime evidence
makes recovery report `original-volume runtime archive required`. Capture its
exact stopped volume with the generic helper, then build the archive and repeat
recovery:

```bash
python3 scripts/cloudbench-original-volume-capture.py \
  --registry <git-common>/cloudbench-fleet-ownership/<exact-owner-token> \
  --bench <task> --machine-id <machine> --volume-id <owned-volume> \
  --capture-dir <absolute-private-capture-directory> [--preflight-only]
python3 scripts/cloudbench-build-interrupted-pool-archive.py \
  --registry <git-common>/cloudbench-fleet-ownership/<exact-owner-token> \
  --capture-dir <absolute-private-capture-directory>
scripts/run-bench --recover-stale-owner <exact-owner-token>
```

The helper verifies owner, run, Machine and volume against the registry, audit
and native Machines API, and holds the owner's recovery lock. It saves the exact
original config, changes only `init.cmd` to `sleep infinity` while stopped, and
boots once. It refuses any inherited `init.exec`/`init.entrypoint` or live driver
process. It copies the `original_files` set of `cloudbench-startup-failure-archive.py`
read-only, then stops and restores the exact config without starting it. It writes
`<machine>.tar.gz` and `<machine>.provenance.json` only after the native
stopped state is proven. Missing files stay listed as missing. It never deletes
or reaps, grants zero credit, and refuses foreign/live owners, changed configs,
destroyed or running resources and existing captures. A failure leaves
`<machine>.capture-failure.json`; if the original config is not proven restored,
rerun with `--restore-original-config` and the same capture directory. Archive
building and recovery still apply their own exact checks.

For generic failed-owner recovery, `_forensic/archive-verified.json` preserves
complete originals with `native_release_verified=false` and zero proof credit.
Continue `scripts/run-bench --recover-stale-owner <exact-owner-token>` through
its exact resource reaper and final native provider audit. Archive readiness is
not release; follow the Operations Runbook's recovery guidance instead of calling the archive
verifier directly. Other forensic receipt modes keep their existing contracts.

Cancelling a fleet (a campaign's process-group TERM, a terminal Ctrl-C or a
hangup) keeps each runner's data-plane proxies alive until the authenticated
guest `/shutdown` has been sent: the per-bench supervisor signals the runner
before its process group, always as TERM because the runner inherits SIGINT
ignored. When the guest accepts the request, the runner publishes an exact
run-scoped `guest-shutdown.requested` receipt before waiting for its cleanup
acknowledgement. Controller cleanup natively stops (never destroys) only an
exactly owned guest that no party delivered a stop to: its own request was
rejected and no matching receipt exists. A delivered guest that is still
draining is left running and stays on the normal acknowledgement and retention
path. The native stop has one deadline inside the cleanup ceiling, bounded
Machines API calls and a bounded stop retry, and only a verified `stopped`
state counts; `created` or `suspended` remains unresolved. Its result is
recorded in `guest-native-stop.json`. In every unacknowledged case the owner,
volume and unconfirmed-cleanup quarantine stay retained; recover with
`--recover-stale-owner` (a stopped guest needs the original-volume archive).

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

### Provider rate-limit concurrency cap

Benchmark guests share the Parallel Search+Extract and Kernel browser keys with
production. `scripts/cloudbench-provider-limits.json` records each enforced
limit, the measured run600c per-bench peak and a 20% production reserve; the
cap is `floor(limit × 0.8 / per-bench peak)`, minimum across enforced providers
(`python3 scripts/cloudbench-provider-capacity.py cap`, `cap --json` for the
table). `run-original600-controller.py` (including `--check`), campaigns (whole
sharded group), fleets and `--local` refuse a wider global simultaneous width
with exit 78 before any credential or provider call. Do not retry, split or
work around a refusal: ask the user to raise the provider limits (then record
them in the registry in a reviewed change) or rerun at or below the cap.
Task-free `--infra-probe` fleets and validated `--demo-cache` replays are exempt.

### World-model refresh conformance

`bash scripts/run-bench-cloud --refresh-wmh` incrementally exports every real
completed tool result from eligible archived trajectories, including results
already present in an active or interrupted run whose final DB fixture has not
been written yet. Launch-only shells with no end fixture or incremental result
artifact are skipped because they contain zero completed steps. Normal
refreshes scan the complete eligible archive; an
explicit positive `WMH_REFRESH_MAX_BUNDLES` is diagnostic-only. The command
refreshes the WMH retriever and writes
`/data/world-model/conformance.json`. Corpus coverage is intentionally broader
than simulation: general-purpose orchestration is learned but remains real at
runtime; only `is_world_model_environment_boundary()` calls are intercepted.
Completed DB fixtures use the same projection as the live agent boundary:
model-hidden and child/UI lifecycle rows are removed, each assistant/DAG action
is paired with the latest real terminal result for its agent-scoped tool-call
ID, and legacy browser action rows remain separate per-action transitions.

The cloud refresh fails closed unless the generated OTel contains 100 valid,
redacted, category-stratified examples spanning at least 10 real trajectories,
five categories, and ten concrete tool names. The report lists that coverage
and rejects unavailable or simulated observations. For deliberately scoped
diagnostics, opt into the existing `WMH_REFRESH_MAX_BUNDLES`/step-limit
variables; normal maintenance leaves them at zero and embeds the complete
eligible corpus. The 100-example conformance gate itself is fixed for the
maintenance entrypoint.

After serving the built artifact, run the same examples through inference:

```bash
python -m benchmarks.run_world_model_conformance \
  --suite /data/world-model/conformance.json \
  --url http://127.0.0.1:<wmh-port> \
  --model rose-r2-archive-anthropic \
  --output /data/world-model/prediction-conformance.json
```

The prediction gate requires all 100 calls to succeed, mean aggregate fidelity
of at least `0.70`, and mean content accuracy of at least `0.25`; the JSON also
breaks fidelity down by tool category.

## Suites (tags)

The curated tag vocabulary (each task carries zero or more):

| Tag                 | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `antibot`           | Bot-challenge / biometric-defeat browser tasks                          |
| `attachments`       | Tasks with file attachments or document handling                        |
| `auth`              | Tasks needing authenticated sessions (cookie, minted, or anon accounts) |
| `browser`           | Browser agent tasks                                                     |
| `cache`             | DEMO cache record/replay tasks                                          |
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

These production sources are queried only when the backend under test is
production (`--prod` or a non-loopback `--url`). A loopback stack — `run-bench
--local`, `scripts/run.sh` or an isolated cloud guest — runs its own backend,
worker and completions, so prod stores cannot contain its agents. Its
`worker_logs` come from the stack's local worker files, and `backend_logs` /
`research_logs` carry a skip note; the full stack logs stay in its run archive.
`SUPABASE_PROJECT_REF` falls back only to the project named by the configured
`SUPABASE_URL`, never to a hard-coded production project.

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

## Operations Runbook

Moved verbatim from `CLAUDE.md`. "This file" means these instructions;
**Fresh clone setup** and the **Critical Rules** remain in `CLAUDE.md`.

### Benchmarks and cloud fleet

**Benchmarks:** `scripts/run-bench` is the one supported entrypoint for humans,
`/benchmark`, and `/descend`; see `agents/benchmarks/README.md` for the full CLI.
**Benchmark communication and maintenance:** every launch prints the canonical
parent-agent contract in `.claude/shared/benchmark-report-format.txt`; retrieve it
without launching anything with `scripts/run-bench report-format`. All benchmark
progress and final messages must use its full scorecard with actual CSS-colored
text on boxes.dev, with no surrounding prose. Use the documented diff fallback
only when HTML rendering is unavailable. The first row names the
Experiment Number; include actual launches/day for this goal and a compact table
of the last three experiments with their own original trigger/end/elapsed,
queued/running/terminal counts, PASS/AGENT FAILURE/INFRA FAILURE, unknown outcomes,
cost/cache/LLM coverage and lifecycle evidence. Use one status emoji per worker,
recorded scope tokens spent, rolling 15-minute tokens/min and LIFE at the far
right. Remove UPD, wheels and the old standalone active-run/progress/metrics and last-slice sections.
A delay needing action belongs in ISSUES / NEXT ACTION with an owner and concrete
correction. Do not reset clocks or discard attempts.

The root agent must continuously drive the experiment iteration loop above.
Immediately stop the exact owned run at infra >=5% of its original scheduled
total (`20 * infra_failed_jobs >= scheduled_total`): for 600 jobs, 30 failures.
Retries never change the denominator or count a scheduled job twice.
Preserve its original breach and repair the critical causes before rerunning.
Ordinary task failures do not add a global gate; independent campaigns, RCA
workers and operational monitors continue. Preserve resource safety, explicit
user stops, scoped approvals and authorized budgets.
Delegate independent issues with `/RCA` and their exact evidence. Delegate
`/deploy` on an immutable full-SHA checkpoint captured at dispatch in an isolated
checkout; later root changes are excluded unless explicitly handed off as a new
verified checkpoint. On boxes.dev use managed threads by default. Existing
human approval requests use `.claude/shared/approval-format.md` with the same
scorecard styling, six required sections, exact diffs and clickable evidence
links. Downstream includes emoji severity, the evidence-based estimated share of
future real production trajectories affected, and an emoji risk level; unknown
estimates must stay explicit. Do not create additional approval gates for this
presentation policy.

The [PR #1450 continuation checkpoint](docs/benchmark-pr1450-continuation.md)
records the current deployment gaps, source-bound verification and the pending
five consecutive LIVE 50-task runs. Read it when continuing that work.
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
read them with `cloudbench_pid_start_time_like` for the recorded format. Linux
uses the stable boot ID and process start tick; raw `ps lstart` can move after a
VM clock step. The shared reader also normalizes legacy macOS day spacing.
After signalling a supervisor, an empty observation with a still-live PID means
keep joining within the existing shutdown budget, not successful release. The
existing `cloudbench-pid-identity` and `run-process-cleanup` deploy controls cover
these boundaries without adding per-step timing gates.
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
establish that exception. If cancellation interrupts initial session preparation,
inspect whether `_init_browser_session_preserving_owner` joined the same bounded
init request, retained its returned task/session handle, and closed that exact
session. Its existing FE-only cleanup terminal can carry a positive
`browser_preparation_cancellation` receipt; archive capture and publication bind
that receipt to exact owned inventory and native provider closure. Started or
unknown-phase tasks still owe their playable recording. Missing action markers
alone prove no exception, and missing original receipts must never be backfilled.
An initial HTTP transport disconnect is separate from caller cancellation. The
backend init route keeps the same allocation operation owned and closes its exact
returned session if the response closes before `writableFinished`; normal response
completion keeps the session. Failed close retains the existing terminal retry
owner. It creates no preparation receipt or recording exception.
The durable publisher checks these proofs; never synthesize a recording or waive
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
1,200 seconds per task and 5,400 seconds from the first uncached image invocation
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
account for settled shared exceptions. Existing DEMO cache regressions cover
waiter/owner cancellation and HTTP-error propagation without longer deadlines.
The existing `BENCHMARK_FAST_MODE_CACHE` A/B setting controls the Fast Mode provider-speed button;
it does not disable DEMO cache replay. Catalog `demo_cache: on/off` (legacy `fast_cache`) declarations
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

### Eval Suite operations

**Current width-fifty LIVE acceptance:** the original hundred-task campaign is
complete. The new goal is five consecutive runs of fifty distinct, randomly
selected eligible DAILY tasks per run. Keep the original completed campaign and
the cached mass-demo diagnostics separate; neither supplies this new streak.
Each run gets a temporary 1,200-second execution window per task and a hard
5,400-second whole-run budget from the start of its uncached image build through
final durable publication and verified release of every owned resource. The old
300/600-second temporary task settings, 1,800-second allocation budget and cached
diagnostic's 1,200-second allocation-to-release guard do not apply to this goal.
Normal defaults, task contents, evaluators and the provider waterfall stay intact.

A fresh CLI runner reads this file and uses the ordinary entrypoint. Make a
minimal benign comment change in `agents/benchmarks/__init__.py` in its own
checkout for each trial, record the resulting fetchable immutable ref, and build
from that same checkout. This marker changes neither executable behavior nor the
39 bootstrap/79 dependency inputs. Preserve any already-running control's source.
Complete Fresh clone setup's backend import check before recording the image
start clock. Use the supported uncached image build and exact-image activation
for every trial:

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
Pass all fifty concrete names to the normal CLI with `--retry-infra 1` and
`--concurrency 50 --strict-barrier`. This opt-in uses the existing isolated
campaign controllers and shared preflight/inventory, keeping one logical
fifty-task group. The sequential proof wrapper's width-32 cap is unrelated.

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
  scripts/run-bench "${tasks[@]}" --ref "$trial_ref" --timeout 1200 --autoscale-max 15 \
  --retry-infra 1 --concurrency 50 --strict-barrier --e2e-timeout 5400 \
  --e2e-started-at "$(cat "$trial_dir/image-start.epoch")"
```

The requested retry policy applies only to infrastructure failures. Admit at
most one fresh attempt for the same task after the prior controller exits,
its exact native resource audit closes, and its terminal physical result is
published with lifecycle `released`. Healthy peers continue; genuine task FAIL
is accepted without retry. Each attempt retains its own physical run, logs,
evidence and costs under the original logical group member and timestamp.
The failed attempt stays visible in history and earns no execution credit.
Retry does not rebuild the image, alter the task, or restart either clock.
An unclassified result, retained resources or pending publication blocks retry;
follow the printed exact-owner recovery instructions instead of deleting claims.
The original image-start epoch includes activation, gaps, all attempts, evidence
and complete release in the 5,400-second cap. Normal 7,200-second defaults remain
unchanged. Compact owning scheduler, publication and grouping regressions run
in the normal deploy gates; large LIVE campaigns remain user-requested.

Fixture readiness files must become visible with a complete payload: write a
sibling temporary file, then atomically replace the final path. Existence alone
does not prove that a direct JSON/PID write has finished. Keep cleanup controls
within the existing fixture host guard rather than adding narrow stage timers.

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
owner and private evidence. A positively absent fresh primary with its exact
original run ACK, complete seal and ownership/source binding can skip reconnect
while the owner remains quarantined. A destroyed native tombstone also requires
the exact clone name, original config token/source/Volume, and current unlisted
Machine identity. This read-only recognition grants no reap
authority; normal guest acknowledgement, evidence and native reaper stages
still own latch/policy transitions and full release. Recovery's local proxy lease adapter represents an
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
| Whole image-start-to-publication-and-release E2E | 5,400 seconds, hard | Original per-trial clock, including gaps, waits and teardown. |

Stage targets are not additive entitlements:
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
parallelism-caused issue or the ninety-minute breach fail the run. Preserve every
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

For a credential-restore failure, inspect the first native seed error before the
later cleanup exception. `PrismaClientInitializationError` with
`max client connections reached` can occur at the initial database read,
before any credential payload is read. Selected-user hydration now owns that
first read through the existing bounded table retry; credential tables still run
once and retain their own retries. Preserve the selected user and credential
scopes. Pool occupancy needs separate evidence before changing capacity or env.
A driver exit without its exact cleanup ACK remains failed; stopped services
alone do not certify browser/provider release or a benchmark result.

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

REAL tasks now use fresh primary and worker volumes by default with the verified dependency image, exact authenticated Git checkout and the same canonical isolated database fixture. SIM tasks, including `--sim-on` overrides, retain their snapshot and cached World Model assets. `--snapshot-volumes` forces the historical restored-volume path for a provider diagnostic; generic `--provision-pool` and legacy startup keep compatible snapshot storage. Source-only changes reuse the pinned image and inject current bootstrap helpers. A successful clone command precedes storage readiness: inspect its exact owned IDs and keyed volume state when preflight waits; retain the original failed receipt and let the owning CLI finish cleanup. A 40GB volume restored from the donor snapshot stays RESTORING for about ten minutes (measured 590-909s on 2026-10-19), so snapshot clones wait up to `CLOUDBENCH_CLONE_SNAPSHOT_RESTORE_SECONDS` (default 1800) while fresh clones keep the 600s budget; `CLOUDBENCH_CLONE_STORAGE_READY_SECONDS` overrides both.
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
The default mass-task primary uses `shared-cpu-4x` / 4 GB; its optional worker
uses `performance-1x` / 2 GB (`shared-cpu-2x` primaries were throttled to 81-93%
CPU steal in descend-full69 proof 2). Fifty primaries add 200 active shared CPU
units, above the default 160-unit governor less its 20 production units; the
campaign planner derives the required governor from the actual task shapes. Native CPU kinds/counts and live workstream reservations
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
