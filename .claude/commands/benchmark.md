---
description: "Run benchmark tasks through the isolated cloud fleet by default; use --local explicitly for local benchmarks and evals."
argument-hint: "list | eval [--bench rose-bench|pipeline-e2e] [--agent-only] [--only a,b] | <slice-or-task...> [-k K --concurrency N] [--timeout S] [--check] | --local <task...|--full|--rerun-failed latest>"
---

# Benchmark Runner

Use the repository entrypoint for benchmark and eval runs, from the repository root:

```bash
scripts/run-bench $ARGUMENTS
```

Every launch prints the mandatory parent-agent format and maintenance contract.
Read it, and the Operations Runbook in `agents/benchmarks/README.md`,
before communicating or scheduling the next slice; retrieve it again
without a launch with `scripts/run-bench report-format`. Its single source is
`.claude/shared/benchmark-report-format.txt`, governed by
`.claude/shared/report-display-format.md`. Render the card only with the
printed `scripts/run-bench scorecard <run-dir> --html <file>` command and publish
that file; never hand-write it. Use its inline CSS-colored scorecard
on boxes.dev (the `--text` fallback only when HTML is unavailable): headline
QUEUED / IN_PROGRESS / COMPLETED, then PASS / HARNESS FAILURE / INFRA FAILURE.
Preserve genuine agent failures, cancellations and unknown classifications
separately; keep the infra threshold in a minor note. Include the latest three
experiments, last-run age, recorded tokens/15-minute rate, LIFE and lifecycle
coverage. Refresh on the 10-minute checkpoints and transitions below, without
resetting clocks or stopping ongoing work.
Use the original scheduled denominator for the existing 5% infra stop policy,
not completed attempts. Delegate issues with `/RCA` and `/deploy` only within
the user's authorized scope, using isolated immutable checkpoints.
Required approval requests follow `.claude/shared/approval-format.md` instead,
using the same styling and its complete evidence/diff/Links requirements.

**Default delegation and parent cadence (user instruction, October 20, 2026).**
By default, a sub-agent owns each benchmark run: launch (or adoption of an
already-launched run), operational monitoring, infra-failure `/RCA` delegation,
exact-owner cleanup and the returned results with clustered failures. The main
agent does not poll the run itself. It posts only the CLI-rendered batch
scorecard, every **10 minutes** and on three transitions: tasks started, no more
queued, and run end (an infra early stop counts as the end). Approval requests
for harness and eval fixes still go to the user from the main agent.

**Resumed Polar scope (October 20, 2026).** The user's newer instruction
supersedes the attachment's 50-task suggestion: at most **20 tasks at K=3**,
grouped by comparable expected duration, fastest groups first. Reconcile and
preserve accepted K slots before selecting only missing slots; do not rerun
accepted slots to fill a batch. Execution timeout is **7200 seconds (2 hours)**;
reject larger values with the requested lower-timeout/settings explanation.
After each batch, wait for the user's explicit go before the next 20. Neither
continuation, an infra repair nor a completed review grants that go. Keep BU
results separate and report benchmark costs and retry costs without inventing
missing charges. Do not use Gmail, Calendar or Drive for this work.

**Explicit same-cohort rerun authorization (October 21, 2026).** After the three
aligned repairs (result-preserving real pause, actual final-answer evidence for
all benchmarks, and bounded/retrievable tool results for main/explore/browser)
are implemented and well tested, run the **same 60 with the same CLI in a
benchmark sub-agent**. Align fixes one at a time, implement independent agreed
fixes in parallel; see `/descend` for the retained behavior contracts. This is
an explicit repeat of the original 20-task K=3 cohort, not Batch 2 or permission
for the next 20. Preserve original settings, baseline grades and producer clocks;
record the rerun separately. Existing backend-first, warm-source and admission
requirements still apply; recorded authorization needs no duplicate permission.

Actual final-answer/completion-card evidence must reach the evaluator for **all
benchmarks by default**. Verify the real producer-to-evaluator path, preserving
text/errors and distinct messages; a fixture-only pass or judge-only replay is
not a benchmark outcome. Tool-result truncation must keep bounded previews plus
retrievable full tails across main, explore and browser, using one shared helper
and one paged read through existing attachments, with generous fallback limits
where previously uncapped. Keep full authorized archive/evaluator evidence and
existing redaction/access controls; do not expand this into a new storage system.

Harness/eval candidates go only through main-chat approval, sorted by
priority then affected-run count, showing **X of N**, overlapping memberships
and the exact inline diff. Use `/descend`'s owning failure-clustering guidance
for causal coverage and reference policy. Mocked causal checks, restored judge
evidence and judge-only replays never become accepted benchmark outcomes.
These scope rules override unrelated campaign profiles below.

For the current user-requested five consecutive LIVE DAILY runs of fifty,
follow the **Current width-fifty LIVE acceptance** subsection of
the Operations Runbook in `agents/benchmarks/README.md`. Each run
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
verdicts and generous fixed historical LIVE stage targets. The existing stability
wrapper's width-32 cap does not restrict this ordinary fleet; do not substitute
smaller slices.

Behavior:

- `scripts/run-bench list` prints the benchmark catalog.
- `scripts/run-bench <slice-or-task...>` runs one isolated cloud fleet, with every resolved task running concurrently in its own Machine, database, backend and Temporal queue.
- `scripts/run-bench --local <task-name...>` explicitly selects `agents/benchmarks/local.py` and its isolated local stack.
- `scripts/run-bench eval ...` runs `agents/benchmarks/run_eval_suite.py` through the isolated local stack.
- `scripts/run-bench <task> -k K --concurrency N` runs K independent copies with at most N active. These flags select a bounded campaign; omit them for one fully parallel slice.
- Wide cloud runs route automatically to the sharded controller operator when more simultaneous copies run than one controller's copy bound (32): `scripts/run-bench <slice-or-tasks...> [-k K] [--timeout S] [--e2e-timeout S]`. It is the same path used for original600/polar70: an ordered manifest, K repetitions, auto-sized disposable controllers behind one global strict barrier, and the provider-cap and native-capacity checks. Guests run the clean, pushed HEAD. Launch facts, the warm dependency proof and snapshot inventory are discovered from their normal producers. A warm snapshot not produced for this exact HEAD with its dependency fingerprints, or one that expires before the run deadline, is first refreshed with `run-bench-cloud --refresh-deps`. Every routed launch runs `--check` before `--run`. Use `--check` alone for a dry run with no allocation; it reports the reuse/refresh decision. Report progress only with the CLI-rendered FORMAT v8 scorecard printed for the admission directory: `scripts/run-bench scorecard <admission-dir> --html <admission-dir>/scorecard.html`.
- `scripts/run-bench stability-proof -k K --concurrency N --seed S` runs K sequential random slices of N distinct tasks. This proof wrapper has a 32-task width cap; it is separate from the predeploy selection cap of 20. For a wider explicitly requested slice, resolve the concrete task names and pass them together to the ordinary fleet entrypoint.
- `scripts/run-bench <production-only-task>` uses the existing controller-local production runner without allocating Fly guests.

`/deploy` uses `scripts/run-predeploy-local` → `scripts/run-bench --local` by default, with the history-qualified selector and its hard cap of 20; its explicit cloud alternative uses the same fleet scripts. Production payment verification uses `scripts/run-bench agent-payment-production-abandonment`. Keep compact runner regressions in the existing deploy gates; a large live stress run requires an explicit user request and does not become an automatic deploy stage.

### Hub infrastructure experiment prerequisite

An infrastructure experiment must not wait for the entire `/deploy` workflow.
Qualify the affected Hub code and its owning controls, then verify that the
**actual endpoint used by the experiment** serves that source. Keep unrelated
application deployment gates pending; production promotion still follows its
normal authorization, qualification and rollback requirements.

The existing endpoint override is `BENCHMARK_HUB_UPLOAD_URL`. Set it inside the
source-bound remote controller command: `run-cloudbench-controller-gate` does
not automatically forward the caller's environment to the Machine. The
campaign publisher inherits that environment; nested canary preflight clears
parent/group run IDs but retains the endpoint; fleet registration, visibility
checks and final aggregate publication use it. Guest tasks retain the owned
parent run ID rather than creating duplicate registrations. Keep authentication
in the existing managed secret files, never command arguments or public logs.
Record source, endpoint, storage scope and the normal visibility/publication
receipts; an environment setting alone is not service-alignment evidence.

A localhost/127.0.0.1 override does not remove durable-publication or canonical
evidence requirements. Individual result uploads retain their normal mirror,
but the fleet/campaign aggregate CLI currently publishes only to the configured
endpoint: it does not invoke that mirror. An override alone therefore does not
prove durable aggregate publication. Do not bypass that unsupported boundary.
The conditional-write publication codec requires compatible readers and a
compatible rollback: an isolated experiment must not write envelopes into an
old-reader production bucket. A local-file Hub does not qualify the R2 fence.
An explicitly authorized real-R2 experiment can use
`BENCHMARK_HUB_STORAGE=r2-isolated` with `BENCHMARK_ISOLATED_RUN=true`, a fresh
root-issued `BENCHMARK_RUN_ID=hubxp_<32 lowercase hex digits>`, complete existing
R2 credentials, and `BENCHMARK_HUB_ISOLATION_INTENT` naming its root-owned,
read-only regular scope file. The intent binds schema
`benchmark-hub-r2-isolation-v1`, mode, run ID and bucket. The caller must issue
it with a fresh UUID and exclusive creation; syntax alone does not prove
freshness. All five Hub key families use the disjoint
`benchmark-hub-isolated/<run-id>/` prefix in the existing bucket. Do not spoof
`RENDER`, create a bucket, or fall back to local storage on invalid configuration.

Before and after the experiment, account for every original physical attempt
in a sealed manifest: its real canonical bundle and existing-CLI publication
receipt, or an explicit missing-canonical-bundle reason with original ledger
custody. Preserve all original grades, clocks, identity and private endpoint
ACKs. Publish each real canonical attempt bundle plus the group afterward with
existing `hub_upload.py --upload-final`, explicitly targeting production and
preserving the original publication/group environment. Never copy private
wire envelopes to the production prefix or fabricate missing/no-agent rows.
The normal publisher's diagnostic stripping/body limits remain visible; full
originals stay archived. Use the existing per-agent evidence publisher for
actual roots/recordings/last LLM dumps. `--verify-visible` alone proves run ID
visibility, not full-body equality.

If the compatible service/storage or complete original custody/publication
manifest is unavailable, report that specific prerequisite instead of launching
against the old Hub, inventing a publisher, creating an unapproved external
service/bucket, or queuing the full app deployment as an experiment dependency.
An authorized infrastructure experiment may use the supported owned local
isolated backend/database and authenticated tunnel. Keep normal source, native
capacity, ownership, clocks and physical resource guards unchanged.

Ordinary cloud runs automatically reuse verified completed dependency snapshots,
including from fresh checkouts. Use `scripts/run-bench --help` and the Operations Runbook's
"Cloud startup reuse" guidance; do not rebuild dependencies for source-only changes.

Before an image-build-to-fleet measurement, complete CLAUDE.md's **Fresh clone
setup (Andy’s Mac)** dependency reuse and actual backend seed-cache import check
before recording the image clock. The image-only publisher needs no backend
dependency check.

An explicitly requested uncached image measurement uses
`scripts/run-bench image-build --builder depot --no-cache --build-context <checkout> --out-dir <private-output>`.
The selected checkout supplies the Dockerfile and Fly config. Its receipt records
pre-launch source/dirty status, recipe/config hashes and build/push timing;
it does not prove artifact equivalence. The final image layer installs the
unchanged npm/Prisma and Python dependencies concurrently and joins both before
publication. Ordinary branch runs continue to reuse verified dependency images.
`image-build` defaults to Fly-integrated Depot (app scope, zstd level 3,
`linux/amd64`); `--builder native` selects an explicit native diagnostic. The
independent `807edee9f` no-cache build/push completed in 493.6 seconds in one attempt,
excluding activation/fleet startup. Activate the exact receipt image and verify
guest digest/runtime consumption before the benchmark cohort.
Image publication automatically caches a checksum-verified pinned Fly client in
the Git common directory. Native publishing uses only the image child’s classic
Docker/HTTPS settings (`DOCKER_BUILDKIT=0`, `--wg=false`); shared Fly/PATH and the
benchmark runtime remain unchanged. The tiny supported CLI control took 31.6
seconds including client installation and push, not a full cold build. No manual
download is needed for a fresh worktree.

For the existing recorded mass-demo cache diagnostic, from the repository root:

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

An accepted delete plus an exact owned-volume `pending_destroy` or `destroyed`
terminal receipt qualifies release even when Fly retains the object. Request
acceptance alone does not establish release.

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
For a retained failed owner, follow the Operations Runbook's exact-owner recovery route.
An `archive-verified.json` receipt preserves originals with zero proof credit;
keep monitoring the supported CLI through the final native release audit.
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

These are 50 independent one-task controllers, each retaining the task's 50
first-level general-purpose children: 2,500, with existing explore allowances unchanged.
They are not 50 distinct tasks. The explicit flag requires an existing DEMO task
admitted by runtime replay policy with `fast_cache:on`; task agents stay read-only
and refuse live fallback on misses or unresolved context. The separate harness
keeps genuine evaluation, including declared LLM judges that may call providers.
Do not claim a recorded hit for existing cold-terminal passthrough, total zero
provider spend, or LIVE acceptance credit. Do not edit tasks, prompts or evaluators
to create a cheaper passing fixture. The compact mode/handoff controls run in
the existing deploy gate; this large diagnostic remains user-requested.
With repeated copies, `--strict-barrier` releases a bounded cohort only after
every surviving eligible copy finishes its normal stack and autoscaler readiness.
Ordinary terminal member failures stay failed while healthy peers and later
cohorts continue. Keep the original requested count and actual released/failed
counts; partial release never earns full-width credit. Shared publisher or parent
loss, invalid readiness ownership or release membership, and explicit cancellation
retain owned abort handling. Non-strict sliding scheduling remains unchanged. Report actual task start/terminal overlap, not controller count.

Follow the exact monitoring command printed by every launch. Poll every 30 seconds;
check controller terminal status even when the card is stale, and continue through
owned-resource release. See the Operations Runbook's "Monitor every cloud launch" guidance.
Task verdicts appear before cleanup; observation timeouts never authorize a restart.

Keep the ordinary 7,200-second backstops. For an explicitly requested five-minute validation, set `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300` and pass `--timeout 300`; the environment setting bounds task execution and the flag bounds the controller path. Preserve terminal task grading, meaningful real execution, exact resource cleanup and the separately monitored E2E deadline. Recovered errors and inner latency measurements remain diagnostics for an infrastructure-only campaign; an ordinary task failure can satisfy that campaign without satisfying the deploy smoke gate.

For an explicitly requested twenty-minute task window, use
`BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200` with `--timeout 1200`. This is a
command-scoped execution setting; keep normal defaults. Run latency proofs
without concurrent paid smoke suites.

The entrypoint owns evaluation publication and the live Hub publisher. Task PASS/FAIL
is emitted before agent/phone cleanup; the fleet publishes changed outcomes on
its next aggregation poll instead of waiting for guest teardown. Exact-owner
acknowledgment follows a matching live Hub response before normal cleanup;
a sixty-second publication wait is warning-only and never prevents resource
release. The frontend polls every five seconds. A terminal run still requires actual resource cleanup
and final publication; early results are not a cleanup receipt.

The entrypoint owns local service startup and teardown, per-run ports, per-run
Postgres container/volume naming through `CONDUCTOR_WORKSPACE_NAME`, frontend
and public tunnel URLs, Temporal task queue naming, non-load benchmark
concurrency, load-test serialization, payment fixture setup, failed-agent
retention, and local diagnostics.

Do not start `scripts/run.sh` manually for local benchmark work unless the user
explicitly asks for a shared existing stack. Use `--use-existing` only when
services are already running and the user wants to reuse `.context/services.json`.

---

# Evaluators (how a bench passes)

Catalog: `agents/benchmarks/tasks.json` (one task = one entry).
Runner: `agents/benchmarks/run_benchmark.py`.
Evidence builders: `agents/benchmarks/semantic_evaluator_evidence.py`.

A task can fail in **two layers**. Both must pass when
`enforce_declared_evaluators: true`.

```
agent run finishes
        │
        ▼
┌───────────────────────────────────────┐
│  Layer 1 — harness contract           │  evaluate_task()
│  expected_attention_kind, tool counts │  always runs
│  approval_handling, progress, etc.    │
└───────────────────────────────────────┘
        │ pass
        ▼
┌───────────────────────────────────────┐
│  Layer 2 — declared evaluators[]      │  _run_declared_evaluators()
│  only if enforce_declared_evaluators  │  ALL must pass (fail-closed)
└───────────────────────────────────────┘
        │ pass
        ▼
      PASSED
```

If Layer 1 fails, Layer 2 is **skipped** (the run already failed).

---

## Declared evaluator methods

| Method                  | What it checks                                                           | How                                                          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `static_check`          | Deterministic facts from run state                                       | Exact checks in `checks[]` (counts, strings, status)         |
| `single_turn_llm_judge` | Semantic criteria against grounded evidence                              | One LLM judge call; score ≥ `pass_threshold` (default `1.0`) |
| `agentic_llm_judge`     | Same idea, larger / tool-using judge                                     | Codex agentic judge over a full trajectory bundle            |
| `polar`                 | Odysseys-faithful per-rubric trajectory + screenshots (polar-bench only) | Isolated module `polar_evaluator.py`; perfect score required |

Supported `static_check` `checks[].type` values are listed in
`agents/benchmarks/long_horizon.py` → `RUNTIME_STATIC_CHECK_TYPES`.

### Semantic evidence (tree-aware — the standard)

For `single_turn_llm_judge` / `agentic_llm_judge`, evidence is **root + every
sub-agent transcript** (hydrated via `get_agent_tree` / `collect_tree_messages`),
plus completion card and `_benchmark` state (approvals, attention kinds).

| Builder                      | Budget                  | Fallback                                  |
| ---------------------------- | ----------------------- | ----------------------------------------- |
| `build_single_turn_evidence` | 320k chars              | If over budget → auto `agentic_llm_judge` |
| `build_agentic_evidence`     | larger per-message caps | n/a                                       |

**Rule:** semantic judges must see browser/sub-agent tool evidence, not root
narration alone. Do not score guest checkout, pickup, or item config from
assistant prose without matching tool titles / payment-approval text / session
metadata.

**Do not** relax criteria, judge prompts, or thresholds to manufacture a pass
(CLAUDE.md rule 25 / process-feedback).

---

## Worked example: `browser-blue-bottle-challenge-recovery`

Task goal: guest-checkout Ferry Building pickup → stop at **one unresolved**
`payment_approval`. Harness never approves the charge.

### Layer 1 — harness fields (same task entry)

| Field                                      | Value              | Meaning                                  |
| ------------------------------------------ | ------------------ | ---------------------------------------- |
| `expected_attention_kind`                  | `payment_approval` | Must see that attention kind             |
| `expected_approval_count`                  | `1`                | Exactly one approval request             |
| `approval_handling`                        | `ignore`           | Leave it unresolved (do not approve)     |
| `success_on_payment_card_request`          | `true`             | Payment-card request is a valid terminal |
| `expected_tool_counts.spawn_browser_agent` | `1`                | One browser session (root scope)         |

### Layer 2 — `evaluators[]` (both required)

#### 1. `blue_bottle_runtime_contract` — `static_check`

| Check                                     | Asserts                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `no_tool_failures`                        | No failed tool calls                                         |
| `browser_agent_session_count` min=1 max=1 | Exactly one browser session                                  |
| `approval_request_count` value=1          | Exactly one approval                                         |
| `approval_request_details`                | Approval text contains `"Blue Bottle"` **and** has an amount |

#### 2. `blue_bottle_pickup_order_semantics` — `single_turn_llm_judge`

Pass only when **grounded** tree/payment evidence shows all of:

1. One 16oz iced vanilla bean shakerato with **almond or oat** milk
2. Blue Bottle **Ferry Building** pickup
3. Order **total** and **pickup time/window**
4. **Guest checkout** used
5. Stops at **exactly one unresolved** payment-card approval
6. Order **not** placed (no confirmation / completion SMS)

Judge may treat the pending payment approval itself as grounding for item,
total, and pickup facts. Live menu name `KSE Shakerato` is OK when config
matches. Fail for auth assistance, approved payment, entered card, completed
order, saved-payment shortcuts that skip guest, fabricated facts, DOM-patched
option labels, or other milk.

### How to read a Blue Bottle fail

| Failure string                                                     | Layer      | Typical meaning                           |
| ------------------------------------------------------------------ | ---------- | ----------------------------------------- |
| `Expected payment_approval attention request … none was triggered` | 1          | Never reached payment                     |
| `Approval request count was N; expected exactly 1`                 | 2 static   | Wrong approval count                      |
| `guest checkout is not directly grounded`                          | 2 semantic | Payment OK; guest UI not in tool evidence |
| `Ferry Building pickup and pickup time/window are not grounded`    | 2 semantic | Item/total OK; location/time missing      |
| `Timeout after 1200s`                                              | harness    | Browser loop never hit terminal           |

### Guest-checkout stack note

This task has no live browser-auth fixture. The stack must export
`BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true` (via `local.py` /
`tasks_require_disabled_saved_browser_auth`) so sessions stay
`auth_source=none`. Harness-only env is not enough.

---

## Authoring rules (when adding/changing evaluators)

1. Put the contract in `tasks.json` `evaluators[]`; set
   `enforce_declared_evaluators: true` when Layer 2 must gate the pass.
2. Prefer `static_check` for anything countable/string-matchable; use LLM judges
   only for semantic grounding.
3. Assume tree-aware evidence for every new semantic judge (Blue Bottle is the
   proof path — do not broaden weaker evidence modes).
4. Never rename an existing task `name` (history primary key).
5. Never edit prompt / criteria / timeout / pass threshold to make a flaky run
   green — fix the agent or harness boundary instead.

The publisher starts before allocation and forwards starting/ready/running,
evaluated, teardown and released phases. Keep the parent live until resource
release, then publish its final transcripts. Hub transport excludes only
worker/backend/realtime diagnostic logs; complete messages/tree, task metrics
and evidence references remain, and the original local bundle stays unchanged.
