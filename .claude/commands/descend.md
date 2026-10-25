---
description: "Run a benchmark slice in parallel, cluster all observed errors by root cause, delegate /RCA repairs, and report with the benchmark scorecard. Fix infra without approval; deliver runtime-fix approvals in the main thread. Stop the exact owned run immediately at >=5% infra, repair independent errors with /RCA, and rerun after verified critical fixes."
argument-hint: "<slice> — first N polar tasks | daily | pre-deploy | rose-bench | polar-bench | incomplete | explicit task names"
---

# /descend

Progress displays use `.claude/shared/benchmark-report-format.txt` and
`.claude/shared/report-display-format.md`: a CSS-colored HTML scorecard on boxes.dev with verified
15-minute rates, stall alarms, and a fixed far-right `LIFE` column; no UPD or progress wheels.
This presentation rule applies to current and future agents; approval payloads
retain their required `text` fence.

Apply `.claude/shared/report-display-format.md` to every user-facing fenced
display: 12-hour America/Los_Angeles time (PDT/PST by date), one status emoji,
current-assignment tokens and rolling 15-minute tokens/min, LIFE at the far
right and no UPD or progress wheels.
Place blocking agents above the experiment history.
Persist every user display correction in CLAUDE.md and the shared format.
Report measured Machine states/costs, protected warm capacity and a concrete
unblock action; planner maxima are not a reason to ask for more quota.


**North star: meet the requested benchmark goal with zero reward hacks, repair
owned error clusters, and deploy every confirmed fix. Ordinary descent targets
a trustworthy pass for every original task; infra-only goals use their explicit
acceptance rule.**

This command composes /benchmark, /rca, and /deploy. Read
benchmark.md, rca.md, and deploy.md completely before starting. This file owns
their orchestration, state, user-input gates, and response contract.

Read `.claude/shared/benchmark-report-format.txt` as the single source for
progress/final presentation. The iteration and stop policy below and in
CLAUDE.md governs scheduling. Existing user
steering overrides defaults: persist the requested names, goal, substrate,
budgets, concurrency and acceptance rules rather than importing another run's
special profile. Invocation authorizes running the requested slice and repairing
infra; it does not approve a runtime/product fix or a different paid workload.

## The iteration loop

1. **Run and monitor** the requested experiment on its frozen source. When
   `scheduled_total > 0 && 20 * infra_failed_jobs >= scheduled_total`
   (**>=5% of the original scheduled total; 30 of 600**), immediately stop that exact owned run through its normal controller.
   Preserve the first breach, original clocks, every attempt and its evidence.
   Explicit user thresholds override this default; no minimum sample is added.
2. **Triage every error and delegate independent causes in parallel.** Start as
   evidence arrives and reconcile after each completed or stopped experiment.
   Give each cluster its own available sub-agent running **`/RCA`**, an exemplar,
   exact evidence, fixed milestones and a time budget. Queue excess clusters;
   one fix owner per cause does not mean one author for all causes.
3. **Reproduce, fix and verify.** Require the owning local failure, the identical
   test passing after the fix, a registered regression and unchanged affected
   outcome proof. A passing diagnostic is not proof that the original failure
   was repaired. Keep unreproduced causes open and change the next experiment
   to distinguish them.
4. **Coordinate; do not become the bottleneck.** Review sufficient concrete proof
   once, batch blocking findings and reuse verified unchanged dependencies. A
   second review needs changed bytes, a failed check or a named unresolved risk.
   Do not add bookkeeping acknowledgements, unrelated gates or a full `/deploy`
   before the next useful experiment. Human approval blocks only its scoped action.
5. **Sleep when the critical owners are working and no useful independent work
   remains.** Operational monitors and workers continue. Wake for actionable
   events or every **15 minutes**; inspect evidence, send the full scorecard,
   act on stalls and increase parallelization where useful. Put a one-line
   cause **and corrective action** directly beneath every red progress row.
   If the same blocker persists without new causal evidence at the next check,
   narrow, split, reassign or change the experiment; do not merely report it again.
6. **Rerun the original authorized experiment after verified critical repairs.**
   Leave unrelated RCA lanes moving. Repeat this loop until the requested goal
   passes, then finish the normal deployment, durable publication and owned cleanup.

Parent sleep, user questions and scorecard edits do not pause active workers.
Preparing a command, passing a diagnostic and completing an evidence packet are
substeps; they do not reset the overall RCA scope or establish outcome progress.

## Canonical human-approval format

Both planned user-input gates, and any unplanned human approval permitted by
the composed commands, must follow `.claude/shared/approval-format.md`.
Read it completely immediately before composing the request. The
response-contract fields below add benchmark and lifecycle context, but never
replace the shared Before Behavior, After Behavior, How, TL;DR, Evidence, Detail,
and Downstream Implications sections or their code-block presentation.

## Hard rules

1. **No reward hacking.** Never change a benchmark definition, prompt, expected
   tools, pass criteria, load size, timeout, concurrency, price cap, or
   production behavior merely to make it pass. Never weaken a repro assertion
   or hide a failed primary path behind a fallback. If a task contract appears
   wrong, do not edit it; represent that proposal as a HARNESS row at
   HARNESS_FIX_DECISION.
2. **No RCA without the hard proof pair.** Before a fixed candidate's
   outcome-proof benchmark rerun, the RCA
   must have a local owning-boundary repro actually observed failing on the
   buggy code and the identical repro passing after the fix, with the assertion
   unchanged. For a benchmark failure, that is causal proof—not the final
   outcome proof. The RCA becomes outcome-complete only after the exact
   unchanged post-fix benchmark rerun passes. Otherwise its status is Causal
   proof; outcome pending, or Open observability gap when causal proof is absent.
3. **Every fix is cemented.** Promote the repro into the consistently-run suite
   that owns the first-bad boundary.
4. **Actively drive asynchronous work.** Give a named owner the operational
   monitor, immediate infra-stop/error notifications and normal cleanup. The
   parent acts on events and uses the fixed 15-minute check-in when otherwise
   waiting. Check real output growth and liveness; parent sleep never pauses
   workers. Do not duplicate the monitor with parent-side busy polling.
   4a. **Measure progress from the work itself.** At five minutes with no
   started tasks, inspect the current build/activation/guest stage and its
   original deadline. The assigned operational monitor continues its required
   sampling cadence while the parent waits; require
   advancing producer logs, task transitions or actual guest process evidence.
   A repeated controller wait line is not progress. Zero started tasks alone
   does not prove an infra failure while a requested cold build advances.
   Capture original failure evidence before the owning CLI performs cleanup;
   do not cancel healthy siblings or shorten a budget from an observation gap.
5. **Infra is in scope.** RCA and fix every harness, fleet, credential plumbing,
   capacity, teardown, and control-plane failure. Never kill a benchmark fleet
   not launched by this session.
6. **Exactly two planned user-input gates.** HARNESS_FIX_DECISION gates only
   the affected runtime/product fix; DEPLOY_ADMIN_APPROVAL gates only its
   approval-scoped deploy action. All human requests are delivered by the main
   thread, never by a worker. Neither gate pauses unrelated benchmarks,
   infra repairs or other clusters. Do not ask
   Andy to prioritize independent work, choose between safe implementation
   paths, or approve ordinary infra fixes.
7. **External blockers are not a third planned gate.** Keep every unaffected
   RCA, run, and deploy moving. Report BLOCKED only after all safe in-scope
   alternatives are exhausted and no independent progress remains.
8. **Sync at every safe execution boundary.** Run `/sync` after resolving the
   slice and immediately before every distinct `/RCA` invocation, every
   benchmark rerun, and every deploy-unit handoff. Do not start the next action
   until the main merge, conflict resolution, local DB resync, and affected
   regression gates are complete.
9. **One root-cause cluster per row, one issue class per cluster.** A cluster
   is the set of failed tasks that one fix at one proven first-bad boundary is
   expected to flip. Classify each cluster at that boundary using the taxonomy
   below. If two independent root causes caused one task failure, that task
   belongs to both clusters, as separate lifecycle rows. Never use a downstream
   symptom such as “timeout” to name a class or to group tasks when the
   evidence shows a deeper boundary.
10. **Time every state and parallel lane.** Use `scripts/descend_step_log.py`
    at every state boundary. Completed timings go to the tracked
    `agents/benchmarks/history/descend_steps.jsonl` ledger; `.context` holds
    only active clocks. A state transition is incomplete if its timing command
    did not succeed.
11. **Cluster all errors and run independent repairs in the background.**
    Every failed task gets its own read-only triage card. Capture recovered
    tool/model errors, startup, publication, evaluator and cleanup errors too,
    including errors from passing tasks; keep those diagnostics separate from
    terminal infra counts. Group by observed first-bad boundary, and every
    cluster — a singleton included — enters its own `/RCA` cycle. Give one
    worker ownership of each independent cluster, not one fixer per task.
    Require the unchanged owning-boundary repro red then green and cement it.
    A HARNESS fix needs main-thread approval before applying it to benchmark
    execution or production; an INFRA fix does not require approval. That
    exact rerun supplies `/RCA`'s benchmark outcome proof for every member.
    No fixed task may be reported Confirmed before that proof. An ordinary
    unchanged next slice may run while RCA/proof/approvals are pending;
    pending proof is not a global scheduling gate.
12. **Use the benchmark scorecard.** Every progress/final response follows
    `.claude/shared/benchmark-report-format.txt`, with every section, measured
    clocks, task/infra counts and one line per worker. Approval requests use
    `.claude/shared/approval-format.md` separately, in the main thread. Keep
    detailed lifecycle rows in state; show concise cluster deltas in the card's
    ISSUES / NEXT ACTION section. Never replace the card with the old Markdown
    header/table, and never hide errors to make the card green.
    **Live abort/repair gate:** freeze the original scheduled total from the manifest.
    `20 * infra_failed_jobs >= scheduled_total` stops the exact owned run immediately.
    For 600 scheduled jobs, 1 and 29 infra failures continue; 30 stops.
    Count each job once; retries/cancellations never change the denominator.
    A first failure among one completed attempt is 1/600 for this rule, not 1/1.
    Exactly 5% disqualifies the run. Verify the critical repairs before its next
    authorized experiment; preserve the failed run and original breach. Ordinary
    task failures, unrelated open RCAs,
    unresolved approvals, deploys and missing optional metrics add no gate.
    Native resource admission, exact owned cleanup, explicit user stops and
    authorized scope/budgets still apply; report their actual constraint.
13. **One pass does not confirm a fix for a task that already passes
    sometimes.** Size every outcome proof with
    `scripts/descend_outcome_runs.py` and require every run it asks for to
    pass. Never report Confirmed from fewer runs, and never rerun a failed
    proof to look for a pass.

## Issue classes

Every lifecycle row has exactly one `issue_class`, retained verbatim in state
and in its cluster status/approval. This is the user-facing core claim; the deeper RCA problem
bucket may remain more technical. A class says what kind of failure a cluster
is; it never decides membership. Two tasks with the same class share a cluster
only when the same fix flips both.

| Issue class                      | Use when the proven first-bad boundary is…                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Faulty Evaluator**             | Evaluator code, checks, criteria, rubric, or verifier-scoring instructions disagree with the authoritative task contract—including task-versus-evaluator conflicts—or accept an outcome that contract forbids. |
| **Prompting Inconsistency**      | Two instructions governing the acting agent before evaluation—task, system/tool prompt, or tool/response schema—contradict each other. Evaluator-only scoring conflicts are excluded.                          |
| **Underspecified Task**          | A requirement or preference needed for a unique correct outcome is absent from the task contract.                                                                                                              |
| **Context Drift**                | Relevant context becomes stale, truncated, overwritten, cross-contaminated, or detached from the action it should govern.                                                                                      |
| **Lacking Tool**                 | No available tool or capability can observe or perform a required action.                                                                                                                                      |
| **Broken Tool**                  | The required tool exists, but errors, stalls, returns invalid data, or violates its contract.                                                                                                                  |
| **Product Defect**               | Owned application, service, workflow, or state-transition logic violates a valid contract after inputs and tool delivery are correct.                                                                          |
| **Agent Reasoning Failure**      | Prompt, context, tools, data, and evaluator are valid, but the agent chooses or reports the wrong action or result.                                                                                            |
| **Fixture/Data Mismatch**        | Seed data, identity, account state, credentials, or the benchmark environment contradicts the task contract.                                                                                                   |
| **Resource/Performance Failure** | Owned context growth, cost, memory, concurrency, or timeout policy prevents otherwise valid progress.                                                                                                          |
| **External Blocker**             | A third-party outage, policy block, CAPTCHA, or rate limit prevents completion after owned recovery behavior works correctly.                                                                                  |
| **Infrastructure Failure**       | Fleet, queue, port, build, credential plumbing, teardown, or control-plane behavior prevents a trustworthy verdict.                                                                                            |
| **Observability Gap**            | Required evidence is not captured, so no deeper completed classification is yet supportable.                                                                                                                   |
| **Other**                        | None fits after proof; name the proposed new reusable class in the RCA so this taxonomy can be extended.                                                                                                       |

Boundary rules resolve overlaps: every evaluator-side disagreement with the
authoritative task—including criteria later injected into a verifier prompt—is
Faulty Evaluator. Prompting Inconsistency is reserved for contradictory
instructions governing the acting agent before evaluation. A missing
requirement is Underspecified Task; an absent capability is Lacking Tool; and an
existing malfunctioning capability is Broken Tool. If a tool successfully
delivers valid input but owned application state changes incorrectly, use
Product Defect. Do not call an owned broken recovery path an External Blocker
merely because a third party triggered it.

Map the deeper `/rca` problem buckets into the one-glance classes as follows:

| `/rca` problem bucket                              | `/descend` issue class                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout too aggressive                             | Resource/Performance Failure                                                                                                                                                                                     |
| Logical inconsistency in harness prompts/contracts | Faulty Evaluator for every evaluator-versus-task scoring conflict; Prompting Inconsistency only for contradictory instructions governing the acting agent before evaluation                                      |
| Uncaptured user preference/spec                    | Underspecified Task                                                                                                                                                                                              |
| New tool/capability required                       | Lacking Tool                                                                                                                                                                                                     |
| Concurrency inefficiency                           | Resource/Performance Failure                                                                                                                                                                                     |
| Fixture/environment/data mismatch                  | Fixture/Data Mismatch, or Infrastructure Failure when no trustworthy task verdict exists                                                                                                                         |
| Observability/trace capture gap                    | Observability Gap                                                                                                                                                                                                |
| Other                                              | Reclassify from the proven first-bad boundary, normally Product Defect, Broken Tool, Agent Reasoning Failure, External Blocker, or Infrastructure Failure; retain Other only when proposing a new reusable class |

## Resolve the slice

For daily, pre-deploy, rose-bench, polar-bench, or incomplete, resolve the exact
concrete task list through the canonical catalog selection used by `/benchmark`
(`scripts/cloudbench_catalog.py`, including `tasks.json` and `polar_tasks.json`).
Record the exact names and count before provider actions; show the count and
selection in the scorecard. Do not substitute a differently filtered task group.

"The first 50 polar tasks" means the first fifty names in the canonical
`polar-bench` catalog order, each once, together in one parallel fleet. Freeze
that selection across ordinary descent epochs. Only an explicit random-sampling
request selects a fresh random set for each slice; record its pool, seed and
selected names, and allow overlap between independently sampled sets. A fixed
first-N request is not a random sample or N copies of one task. Explain actual
preflight refusals rather than silently replacing ineligible members.

For explicit task names, use them verbatim. The reported slice must exactly
equal the originally requested and resolved task set; never silently add,
remove, fold in, or substitute another workstream's results. Executing that
slice one task at a time, rerunning a failed subset, or running a diagnostic
subset does not change the original slice name, task list, or denominator.
Record and report every executed subset separately from overall slice progress.

## One benchmark command

Use `scripts/run-bench` for every suite, slice, task, bounded-concurrency
campaign, and repeated isolated trial. Do not invoke `run-bench-fleet`,
`run-bench-cloud`, or an ad hoc repetition loop directly.

Use the current cloud startup and monitoring instructions in
the Operations Runbook in `agents/benchmarks/README.md` for that
command. Strict cohorts now coordinate their physical cleanup reserves on the
controller filesystem; a reserve refusal requires actual disk/cohort evidence,
not lowered storage floors or a replacement launcher. The owning quick
regressions run in the normal benchmark deploy gate.

Keep retained failed-owner recovery on the Operations Runbook's supported exact-owner CLI
route. `archive-verified.json` preserves originals with zero proof credit;
completion still requires the final native release audit and owner retirement.

For a user-requested LIVE width-fifty acceptance run, follow the Operations Runbook's
**Current width-fifty LIVE acceptance** subsection and the latest explicit
steering saved for that goal. Keep its exact temporary budgets, immutable refs,
retry accounting and no paid-deploy overlap; do not copy a historical profile
into an ordinary descent. The existing stability wrapper's width-32 cap does
not restrict an ordinary fifty-task fleet; do not substitute smaller slices.

The ordinary CLI automatically reuses verified completed dependency snapshots
across fresh checkouts. Follow the Operations Runbook's "Cloud startup reuse" guidance and
`scripts/run-bench --help`; source-only changes do not require dependency rebuilds.

Cold-image builds, image activation, and the recorded mass-demo cached run are
explicitly requested diagnostics, never a step of an ordinary descent. A LIVE
goal may explicitly require a fresh uncached image for each trial.

For an explicitly requested cold-image or cached startup diagnostic, follow
the Operations Runbook's CLI commands and `/benchmark` guidance through the same entrypoint.
Do not automatically rebuild images during ordinary branch runs. Cached DEMO
copies earn zero LIVE acceptance credit and retain genuine evaluation; declared
judges may call providers. The mass-demo fifty-copy command means fifty
controllers and up to 2,500 first-level children, not fifty distinct tasks.
Use its documented `--strict-barrier` to coordinate all surviving eligible ready
copies in each bounded cohort. Retain failed members in the original requested
count and report actual released width; partial release never earns full-width
credit. Controller count alone is not execution overlap. Ordinary
non-strict scheduling stays unchanged. Cold image publication automatically
caches a checksum-verified pinned client in the Git common directory. The CLI
defaults `image-build` to app-scoped Depot with zstd level 3 and AMD64; use
`--builder native` for an explicit native diagnostic. Independent `807edee9f` no-cache
build/push completed in 493.6 seconds in one attempt; activation/fleet startup
remain separate stages. Native publishing uses child-only classic Docker over
HTTPS; shared Fly installation remains unchanged.

For an explicit cold-image measurement, activate the exact image from its build receipt before the fleet:

```bash
scripts/run-bench image-build --builder depot --no-cache --build-context <committed-checkout> --out-dir .context/image-build
benchmark_image_ref=$(python3 -c 'import json; print(json.load(open(".context/image-build/cloudbench-image-build.json"))["image_ref"])')
scripts/run-bench image-activate "$benchmark_image_ref" --ref "$(git rev-parse HEAD)" --out-dir .context/image-activation
```

`image-activate` uses the existing app environment lock and owned warm-source setup, activates the published image on the donor and this workspace's pool, synchronizes the requested Git ref, and parks the donor. It sets the existing prebuilt-image selection internally, so it does not build again. Confirm guest image digests in the ensuing fleet's native inventory. Source-only branch runs normally reuse verified dependencies and need no image build or activation.

Repeated concurrent cloud campaigns share one parent-owned Machines/Volumes inventory feed. Borrowers retain the same keyed generation and never stop the publisher; capacity admission and exact resource teardown checks stay native. A standalone fleet and production-only campaigns keep their existing paths.

The existing recorded mass-demo diagnostic, when explicitly requested:

```bash
CLOUDBENCH_APP_MACHINE_CEILING=138 \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  scripts/run-bench test-mass-agent-run-0 --demo-cache \
  -k 50 --concurrency 50 --strict-barrier --autoscale-max 2 --timeout 300
```

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

Follow the Operations Runbook's "Monitor every cloud launch" instructions and the exact command
printed at launch. Poll every 30 seconds, check terminal status on every poll, and
observe through owned-resource release. A stale observation never authorizes a reset.

```text
/descend or operator
  → scripts/run-bench <slice-or-task...> [--concurrency N] [-k K|--runs K]
      → canonical catalog selection
      → one fleet for the ordinary fully-parallel slice
      └─ bounded campaign for task × repetition instances
           → one shared serialized infra-canary stamp transaction
           → at most N one-task fleet controllers
           → distinct controller lock + run ID + machine/volume/queue per instance
  → scripts/run-bench stability-proof -k K --concurrency N --seed S
      → K sequential random ready-catalog slices, N isolated tasks per slice
      → terminal _batch/run.json classification
           ├─ PASSED / FAILED → record and advance
           └─ SKIPPED / INFRA_ERROR / ERROR / CANCELLED → fail closed and reset the streak
```

Named selections are `daily`, `pre-deploy`, `rose-bench`, `polar-bench`, and
`incomplete`; explicit task names may be combined. Selection order is preserved,
group members stay in catalog order, and duplicates are removed. The command
prints the resolved list and count before any provider action.

With no campaign flags, one isolated fleet runs the resolved tasks concurrently
and preserves the single batch artifact. `-k K` and `--runs K` are equivalent
and create K independent runs of every resolved task; `--concurrency N` bounds
how many of those one-task fleet controllers may be active. Repetitions default
to sequential when no concurrency is supplied. `/descend` therefore sets
`--concurrency` explicitly for repetitions: default to the total requested
task × repetition instance count, subject to native admission. Narrow only for
explicit user steering or a concrete resource constraint, and report actual
width; never silently serialize. Every copy remains isolated; never implement
`-k` by passing duplicate task names to one fleet.

For a consecutive no-INFRA acceptance gate, use
`scripts/run-bench stability-proof -k K --concurrency N --seed S`. The sampler
draws every slice from the unified ready catalog (`tasks.json` plus
`polar_tasks.json`), and every slice runs to a terminal batch projection before
the next starts. An ordinary benchmark/evaluator failure counts as a completed
slice; skipped tasks do not prove execution. Missing, malformed, `SKIPPED`,
`INFRA_ERROR`, `ERROR`, or `CANCELLED` task results
abort the command so the streak can restart only after RCA and a fix.

The compact benchmark live-result deploy control also verifies that PASS/FAIL
is projected to the Hub while guest teardown is pending. Keep result visibility
separate from exact resource-release evidence; follow `/benchmark` for the
publication lifecycle and compact permanent regression command.

The command contract is exercised end to end with fake provider children inside
the existing always-run `Descend Command` deploy gate: selection, both `-k`
spellings, concurrency bounds, per-copy identities, child-failure propagation,
ready-catalog random slicing, terminal batch classification, and fail-closed
INFRA reset. This must remain an offline `$0` extension of the existing
always-run `Descend Command` deploy gate; never add a separate live benchmark
stage or cloud wait to `/deploy`.

The sequential proof wrapper caps width at 32. That is separate from `/deploy`'s
20-task selection cap. For an explicitly requested wider parallel slice, resolve
the concrete names and invoke `scripts/run-bench <task-1> ... <task-N>` once,
without campaign flags. Retain one batch, verify observed execution concurrency,
and report provider latency and resource release. Do not split that request into
smaller slices and label it a wide run. Check current provider capacity, controller
CPU and disk before allocation; never reclaim another workspace's resources.
An explicitly infrastructure-only validation accepts terminal task failures under
the user's contract in the Operations Runbook; it does not change this command's default
task-success goal or the stricter predeploy smoke qualification.

## Persistent state

Create .context/descend/<run-id>/state.json and update it after every state
transition. It must contain:

- original resolved slice name, exact task list, and total task count;
- requested completion/acceptance goal and latest user steering, including
  budgets, substrate, sampling rules and authorized repetitions;
- latest executed subset and its exact task list;
- cumulative latest accepted status for every original task;
- controller PID, dashboard, run artifact, agent IDs, and FE links;
- current state and epoch;
- actual benchmark started_at, finished_at, and duration;
- one triage card per failed task per epoch, and the cluster each card joined;
- one lifecycle record per cluster (issue/fix), with its exemplar task, member
  tasks, each member's boundary evidence, required runs and outcome-proof
  result, and every split or merge;
- the exact issue_class for every lifecycle record;
- infra RCA ledger across all epochs;
- all observed error occurrences, including recovered errors on passing tasks,
  with run/attempt identity, verdict impact and stable cluster association;
- latest run's terminal attempt count, infra count/rate, normal-slice hold
  reason and start time, plus separately labeled recovery/proof runs;
- `/sync` checkpoint timestamp, pre/post base SHA, origin/main SHA, DB-resync
  result, conflicts resolved, and affected regression gates;
- Andy decisions and approval snapshot IDs;
- parent approval queue, each request's delivered-at timestamp and the exact
  decision forwarded to its worker; no approval lives only in a child thread;
- deploy unit base SHA, exact fix commits, worktree, worker ID, PR, and status;
- active timing lanes, their current steps, and the last completed timing
  record ID;
- the cluster queue: each cluster's current rank, member-task count,
  complexity class, issue class, and row ID;
- each cluster's pipeline state: idle | applying | outcome-rerunning | rca.

Compaction, session restart, or a sub-agent response must not erase or recreate
state from memory.

## Checked-in step timing

The append-only timing ledger is
`agents/benchmarks/history/descend_steps.jsonl`. It is intentionally tracked in
Git and configured with `merge=union`; do not put these measurements under
`.context`, rewrite old rows, or remove slow/outlier runs. Each completed row
contains the run, slice, task count, epoch, lane, state, status, Git SHAs, UTC
boundaries, and measured duration. It contains no prompts, logs, credentials,
or benchmark output.

Every boundary uses the standard factory telemetry envelope: `workflow`,
`event`, `value`, `recorded_at`, `recorded_epoch`, `workspace`, `git_sha`, and
`branch`. The logger emits `stage-start` and `stage-finish` pairs plus a terminal `outcome`,
prints each record as `FACTORY_EVENT`, and adds only `/descend`
dimensions such as run, slice, epoch, lane, task count, status, and duration.
`scripts/factory_review.py` consumes this checked-in stream directly.

Allocate the run ID, then start the main clock immediately before doing
`RESOLVE_SLICE` work:

```bash
python3 scripts/descend_step_log.py start \
  --run-id "$RUN_ID" --slice "$SLICE" \
  --lane main --step RESOLVE_SLICE --epoch "$EPOCH"
```

At every main state boundary, close the old state and start the new state with
one command. Use the exact state-machine label, including repeated states in a
new epoch:

```bash
python3 scripts/descend_step_log.py transition \
  --run-id "$RUN_ID" --lane main \
  --step SYNC_CHECKPOINT --epoch "$EPOCH" --task-count "$TASK_COUNT"
```

The first transition supplies `--task-count` because resolving the slice is
what discovers it. Later transitions inherit the resolved count.

Use `--status failed`, `--status blocked`, or `--status interrupted` when that
describes the state being closed. Do not reset a clock because a step is slow.
On session resume, inspect the existing active clock in
`.context/descend/<run-id>/timing/` and continue it; if the work was abandoned,
close it as interrupted before starting replacement work.

Parallel RCA and deploy work gets an independent stable lane such as
`rca-I-03` or `deploy-H-02`. Start that lane before its first state, transition
it independently, and close it when its work ends:

```bash
python3 scripts/descend_step_log.py start \
  --run-id "$RUN_ID" --slice "$SLICE" --task-count "$TASK_COUNT" \
  --lane rca-I-03 --step RCA_INFRA_FIX --epoch "$EPOCH"
python3 scripts/descend_step_log.py finish \
  --run-id "$RUN_ID" --lane rca-I-03 --status completed
```

When the controller reaches `DONE` or `BLOCKED`, transition into that terminal
state first so it gets its own row, then close the main lane with
`--run-terminal` so wall-clock trends include the run. Use `--status completed`
for `DONE` and `--status blocked` for `BLOCKED`:

```bash
python3 scripts/descend_step_log.py transition \
  --run-id "$RUN_ID" --lane main --step DONE --epoch "$EPOCH"
python3 scripts/descend_step_log.py finish \
  --run-id "$RUN_ID" --lane main --status completed --run-terminal
```

Before every `/sync`, commit any newly appended ledger rows in a log-only
commit so merging cannot discard them. Commit only the ledger path; never fold
unrelated work into that commit. After closing the terminal main lane, commit
the remaining rows before the final response. `DONE` and `BLOCKED` are invalid
while this ledger has uncommitted rows for the current run.

After each full-slice acceptance attempt and at the terminal boundary, analyze
the recent window against the preceding window. Negative change is faster;
positive change is a regression to investigate:

```bash
python3 scripts/descend_step_log.py report \
  --slice "$SLICE" --task-count "$TASK_COUNT" \
  --lane main --status completed --window 5
```

The completed-only default keeps a quick failed step or blocked run from
looking like a speed improvement. Use `--status all` only when investigating
failure and interruption overhead explicitly.

Report the run wall-clock trend plus the largest step regression and
improvement. Use this evidence to choose iteration-speed work; it never permits
changing benchmark contracts, limits, or pass criteria.

## `/sync` checkpoints

Run the first `/sync` checkpoint after `RESOLVE_SLICE` and before the initial
benchmark. After that, checkpoint at these boundaries:

- immediately before **each distinct `/RCA` invocation**, including each RCA
  worker started in parallel;
- after local verification and before every benchmark subset or full-slice
  rerun; and
- before preparing each isolated deploy-unit worktree.

One checkpoint may satisfy adjacent boundaries only when no commit, working-tree
change, or origin/main advance occurred between them. For parallel RCAs, sync
each isolated worktree immediately before its worker starts; a controller sync
does not substitute for workers on a different base SHA. Triage workers only
read evidence and need no checkpoint of their own.

Before syncing a dirty controller workspace, persist `state.json` and preserve
all in-progress work reversibly. Never discard it to make the merge succeed.
Resolve conflicts by retaining current main behavior and integrating the descent
changes on top, restore the preserved work, run the tests that own every touched
boundary, then record the checkpoint evidence in `state.json`. A failed or
incomplete `/sync` blocks that RCA, rerun, or handoff—not unrelated active work.

## State machine

```text
RESOLVE_SLICE
  → SYNC_CHECKPOINT → RUN_SLICE
  → OBSERVE / CLASSIFY_RESULTS (as results and errors arrive)
      ├─ TRIAGE_FAILURES → CLUSTER_FAILURES → independent repair lanes
      │    ├─ INFRA → SYNC_CHECKPOINT_PER_RCA → RCA_INFRA_FIX
      │    │           → VERIFY_LOCAL → APPLY_AND_CLOUD_RERUN (no approval)
      │    └─ HARNESS → SYNC_CHECKPOINT_PER_RCA
      │                 → RCA_HARNESS_FAILURES_IN_PARALLEL → VERIFY_LOCAL
      │                 → RANK_CLUSTERS → PIPELINE_CLUSTERS
      │                 → main-thread HARNESS_FIX_DECISION [GATE 1]
      │                 → approved APPLY_AND_CLOUD_RERUN
      │    Both: every member + canaries → confirmed ENQUEUE_DEPLOY_UNIT
      │          failed proof → original evidence → re-triage / split / RCA
      ├─ infra-failed jobs >=5% of original scheduled total (30/600)
      │    → STOP_EXACT_OWNED_RUN → CLUSTER_FAILURES / PARALLEL_RCA
      │    → VERIFY_CRITICAL_REPAIRS → next authorized original RUN_SLICE
      └─ terminal slice below 5% → next authorized RUN_SLICE / FULL_SLICE_ACCEPTANCE

MAIN:   monitor current tasks, dispatch/review repairs, deliver approvals,
        and run the next authorized slice without awaiting unrelated lanes

DEPLOY: prepare isolated fix-only worktree → /deploy
        ├─ no admin approval required → merge → verify production
        └─ admin approval required → main-thread DEPLOY_ADMIN_APPROVAL [GATE 2]
                                   → merge → verify production

FULL_SLICE_ACCEPTANCE
  ├─ any non-pass → CLASSIFY_RESULTS
  └─ requested goal + confirmed deploys complete → DONE
```

HARNESS_FIX_DECISION pauses only that candidate's application/outcome proof.
Other ready requests may be delivered independently, and approved workers keep
running. DEPLOY_ADMIN_APPROVAL pauses only that deploy unit. Infra holds stop
the disqualified owned run and its unrepaired rerun, not independent campaigns
or repair work. No lane waits for
all clusters, an infra-zero run, complete optional metrics or all deployments.

User input can be injected at any time and is applied at the next safe boundary,
but the agent deliberately yields for input only in the two states above.

## Benchmark and background repair loop

**Default substrate: cloud fleet.** Every `/descend` benchmark run — the initial
slice, every infra-epoch rerun, every post-approval outcome-proof, and the final
full-slice acceptance — goes through the per-bench isolated Fly fleet. Local is
opt-in only: use `scripts/run-bench --local …` solely when Andy explicitly
directs a local run for that invocation. Do not infer local from convenience,
cost, or a single-task subset.

Run only through the isolated entrypoint (cloud fleet by default):

```bash
scripts/run-bench <resolved slice-or-task names...>
```

`scripts/run-bench` defaults to `run-bench-fleet` and fail-closes on a stale/missing infra-canary stamp.
It owns `--concurrency N` plus `-k K`/`--runs K`
when independent repeated trials are required. Never prepend `--local` unless
Andy asked for local. Never use `--single-box` (disabled; not parallel-safe).

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

Capture the controller PID, dashboard, artifact path, actual start/finish
timestamps, and every agent FE link. Assign the exact printed monitor handles
to the operational owner through controller exit, publication and owned cleanup;
its required sampling and immediate notifications continue while the parent sleeps.
Begin triage/clustering as errors appear; do not wait for the batch to end.
Validate durable FE evidence before citing it in a human approval.

Keep verdict accounting separate from cluster kind:

- **INFRA:** the harness/fleet/runtime environment failed before the agent could
  receive a trustworthy task verdict.
- **HARNESS:** the benchmark reached a trustworthy agent/evaluator verdict, but
  the agent or product path failed the real pass criteria. A fallback or silent
  substitute that masks the required path is a HARNESS failure.

Record cancellation, skipped/unexecuted work and unknown classifications
explicitly. Publication or cleanup failure can coexist with a genuine task
PASS/FAIL: preserve that verdict and record the terminal infrastructure outcome
without rewriting the original evidence. Recovered tool/model errors are error
occurrences, not automatically terminal INFRA failures. Never reclassify a real
runtime/product defect as INFRA to avoid approval.

The root scheduling loop is:

```text
while the requested goal still has authorized work:
    consume actionable monitor/worker events; preserve original clocks/attempts
    if run_active and scheduled_total > 0 and 20 * infra_failed_jobs >= scheduled_total:
        immediately stop only that exact owned run through its normal controller
        preserve its first breach and begin error management now
    triage every new error; group independent first-bad causes
    run /sync immediately before each distinct /RCA or fixed-candidate proof
    dispatch one /RCA owner per independent cause without pausing unrelated lanes
    review concrete proof once; unblock owners and deliver scoped human requests
    run affected checks at the existing safe boundaries
    if critical repairs are verified and the next experiment is authorized:
        rerun the original experiment on the reviewed frozen snapshot
    elif useful independent work exists:
        do it or assign it without competing edits/live experiments
    else:
        sleep interruptibly; workers and operational monitors keep running
    on an actionable event: act without waiting for the scheduled checkpoint
    every 15 minutes, on a fixed deadline:
        check evidence-backed milestones and publish the full scorecard
        put reason + specific action beneath every red progress row
        remove a wait, narrow/reassign a stall or add useful parallel work
        if the same blocker persists without new evidence, change the approach
        return to sleep if the critical owners still need time
    once the requested goal passes: complete normal deploy/publication/owned cleanup
```

Do not stop for Andy to fix infra. Below 5%, unrelated infra RCAs, runtime
approvals and deploys do not add a global next-slice gate. At >=5%, stop the
active owned run and repair its critical failures before rerunning the original
experiment. A verified local fix need not be deployed to production before its
local-snapshot experiment. Keep previous failed runs, rates and clocks in history;
never retry an unchanged disqualified run hoping for a pass or invent an extra
qualification batch before the already-authorized experiment.

With no terminal attempts, report NO TERMINAL ATTEMPTS and investigate the actual
stage; do not invent a zero failure rate or automatically launch another paid
batch. Keep unknown classifications explicit and collect their missing evidence.
Native admission, ownership, authorized budgets and explicit user stops remain
real constraints. The >=5% policy applies to confirmed terminal infra outcomes,
including every retained physical retry attempt; recovered warnings are triaged
but are not silently counted as terminal infra failures.

## Triage and clustering

Triage every observed error, including INFRA, HARNESS, recovered errors from
passing tasks and errors after grading. Start during the batch and update from
final evidence. Ten errors with three causes should produce three RCA workers
and three fixes; only runtime/product clusters require fix approval.

### TRIAGE_FAILURES — one card per failed task

Use available parallel workers for read-only triage; batch related occurrences
when it avoids one worker per log line. A triage worker runs `/rca` Step 0 and
Step 0.5 for its task/error — run artifacts,
worker/backend logs, agent_latency.py, agent_logs.py, DB, relevant HTTP
evidence, then the archive search — and stops. It writes no repro, no fix, and
no code. With exactly one failed task, skip the separate worker: its RCA worker
writes the card as its first step.

Each worker saves `.context/descend/<run-id>/triage/<epoch>/<task>.json` with:

- `task`, `agent_ids`, the verified FE link, and the run artifact path;
- `run_id`, `attempt_id`, error occurrence/stage, recovered status and
  verdict impact; preserve each original occurrence when deduplicating;
- `failed_evaluator`: the evaluator ID and its verbatim failure output;
  use `none` with the actual infra/tool error when no evaluator failed;
- `terminal_status`: the agent's terminal status, plus the last tool call and
  its result;
- `first_bad_boundary`: the owning component and one sentence saying what
  first went wrong there;
- `boundary_evidence`: the exact log line, span, message ID, or DB row that
  shows it, marked `observed` or `inferred`. `observed` means this task's own
  evidence shows that boundary going wrong. A guess from the symptom, from
  another task's card, or from reading code is `inferred`;
- `archive_hits`: matching `docs/rca/cases` IDs with each case's status, or
  `none`;
- `prior_outcomes`: the line `python3 scripts/descend_outcome_runs.py <task>`
  prints; and
- `contrast`: when a passing trajectory of the same task is available — this
  descent's runs first, then retained run records — the first step where the
  failing trajectory diverges from it; otherwise `none`.

A task whose `prior_outcomes` show passes fails only some of the time, so its
`contrast` is usually the shortest path to its boundary: start the RCA from
that divergence rather than from the final error.

### CLUSTER_FAILURES — group by shared fix

Two failed tasks belong to the same cluster only when **one fix at one
first-bad boundary is expected to flip both**. Apply these rules in order:

1. Cards with `observed` evidence of the same mechanism at the same component
   form one cluster.
2. A card with `observed` evidence at the `first_bad_boundary` of an open or
   mitigated archive case joins the cluster for that case.
3. Every other card is a singleton cluster. An `inferred` card never joins a
   cluster with another task; its own RCA has to find the boundary first.

Never cluster on a shared symptom: the same failure string, evaluator, terminal
status, timeout, website, or issue class. A symptom says where a failure
surfaced, not what to fix, and many unrelated root causes end as the same
timeout.

Give every cluster a stable row ID, a kebab-case name for its boundary and
mechanism, its member tasks, and one **exemplar**: the member with `observed`
evidence and the cheapest owning-boundary repro. Membership is a hypothesis
until that member's own outcome-proof rerun passes.

On a later epoch, triage new occurrences or changed boundary evidence, including
recurrences. Add each card to an existing cluster by the same rules before
creating a new one. If a task has two independently observed causes, preserve
both memberships. An unknown cause remains an Observability Gap singleton.

### Delegate cluster ownership

Use managed delegated threads on boxes.dev through the
`boxes-delegated-threads` skill, preferably muted; give each fixer an isolated
worktree and non-overlapping file ownership. Use available worker capacity,
queue excess clusters and keep the main thread monitoring/scheduling. Do not
spawn a separate fixer for each member of one cluster.

The handoff contains the stable cluster ID/kind/class, exact member names and
triage cards, exemplar run/attempt, original failure logs/artifacts, immutable
source SHA, authorized scope/budgets, ordered priorities and a time budget.
Require `/RCA`: runtime evidence and archive search, first-bad boundary,
unchanged causal repro failing before/passing after, cemented regression,
case-file validation, exact member outcome proofs, and a diff/commit handoff.
An evidence gap stays open; a time budget never authorizes guessed repairs.

Workers prepare candidate fixes and proof in their isolated worktrees. INFRA
workers repair and verify without human approval. HARNESS workers return the
canonical approval packet to the main thread; they do not ask the user,
change the active benchmark snapshot, or deploy the candidate themselves.
Return deploy-guard packets to main as well. The parent reviews the actual
diff/proof, delivers each request, and forwards the user's exact decision for
that snapshot. Existing explicit approval is honored; no duplicate request.

Under `/descend`, its parent owns application, exact cloud outcome-proof and
deploy dispatch; this scopes `/RCA`'s standalone fix-and-deploy default. Do not
let a worker independently launch overlapping paid validation/deploy work or
declare a benchmark fixed from its local causal repro.

## HARNESS RCA

Only after CLUSTER_FAILURES:

1. Run `/sync` immediately before every distinct `/RCA`, then run one `/RCA`
   per HARNESS cluster, in parallel with INFRA repairs and benchmark execution
   when file ownership does not conflict. Sync each
   isolated RCA worktree before its worker starts. Give the worker the
   cluster's triage cards; it starts from the exemplar's evidence and does not
   regather what the cards already hold.
2. Produce the local failing repro at the exemplar's first-bad boundary.
3. Implement the root-cause fix.
4. Run the identical repro and observe it pass.
5. Cement the repro.
6. Check every other member's card against the boundary the repro proved. A
   member whose own evidence does not show that boundary leaves the cluster
   and is clustered again.
7. Update exactly one lifecycle row per cluster.
8. Assign exactly one issue class from the pinned taxonomy and record the
   exact, untruncated `task.prompt` of the exemplar for every HARNESS row.
9. Name every member task in the cluster's archive case, so the next descent's
   triage search finds the cluster by task name.

At this boundary the owning-boundary RCA is causally proven, but the benchmark
RCA is not outcome-complete yet. Do not apply the runtime candidate to the
benchmark here or label the row Complete. Rank ready clusters incrementally;
enter main-thread HARNESS_FIX_DECISION for each ready idle cluster with
Causal proof; outcome pending. After approval, the exact
unchanged local-snapshot benchmark rerun of every member either supplies the
missing outcome proof and completes the RCA or becomes new primary evidence for
the tasks that still fail.

Do not stop to ask which RCA to run first. Use all safe parallel capacity.

## Cluster queue

Run every resolved task in parallel, fix infra without approval, triage all
errors and RCA each independent cluster. Rank the clusters as they become
ready. Never wait for an infra-clean run or every other RCA to finish.

The queue holds clusters, not tasks. Sort it by:

1. member-task count, largest first, so the fix that flips the most tasks is
   decided first;
2. complexity class, easiest first, from the table below; then
3. row ID.

Infra and External Blocker never enter the runtime-fix approval queue; keep
their repair/observability states in the same durable cluster ledger.

| Rank | Complexity class          | Issue classes                                                                  |
| ---- | ------------------------- | ------------------------------------------------------------------------------ |
| 1    | Evaluator / task contract | Faulty Evaluator, Underspecified Task                                          |
| 2    | Fixture / data            | Fixture/Data Mismatch                                                          |
| 3    | Product / tool            | Product Defect, Broken Tool, Lacking Tool, Context Drift                       |
| 4    | Harness                   | Prompting Inconsistency, Agent Reasoning Failure, Resource/Performance Failure |

Re-rank only when membership changes: a later epoch's clustering, a split, or a
merge. Between those events the order is stable, and a cluster whose
outcome-proof rerun fails keeps its position.

A cluster is **idle** when it is not applying, outcome-rerunning, or in RCA.
Deliver the top ready idle cluster's request in the main thread. A
lower-ranked ready cluster is not held behind a higher-ranked cluster still
collecting evidence or awaiting a different decision. Deliver each independent
request with its own snapshot ID and full canonical approval packet.

Do not retract a delivered request when the queue changes. Deliver newly ready
independent requests without waiting for an earlier answer; use the current
rank when choosing among requests ready at the same boundary.

## Stop 1 — HARNESS_FIX_DECISION

Enter HARNESS_FIX_DECISION for a ready cluster when that cluster has complete
causal RCA proof: its own runtime evidence, unchanged owning-boundary repro
red then green, a cemented test and a concrete reviewable candidate diff.
Unrelated INFRA errors, running tasks and incomplete RCAs do not delay it.

After the queue is ranked, enter HARNESS_FIX_DECISION whenever the top idle
cluster needs a fix decision.
Never enter HARNESS_FIX_DECISION with an open observability gap. If evidence is
incomplete, keep that cluster in RCA_HARNESS_FAILURES_IN_PARALLEL and gather
its missing proof autonomously. Other ready clusters proceed. The exact
post-fix benchmark outcome
remains explicitly pending until the harness fix is approved (by Andy or a
`GROUNDED` golden review). An
exhausted external blocker follows Hard rule 7; it does not become a
user-response gate.

Main first runs the shared Golden-reference adversarial review on the
packet. `GROUNDED` sets Approval to Fix approved (golden review) and follows
**approve** below without asking Andy. Otherwise main delivers the canonical
request with Causal proof; outcome pending and the `Golden review:` verdict, then
continues independent work. Andy responds with the request ID and approve,
edit, or reject. Infra rows use Not required. Workers never open their own
human approval request. A pending decision gates only its candidate.

- **approve:** set Approval to Fix approved. Immediately fire a sub-agent to
  apply the approved fix on a local code snapshot — not a prod deploy — and
  rerun every member task of that cluster on the **cloud fleet** via
  `scripts/run-bench <task> [<task>...]` (no `--local` unless Andy explicitly
  directed local for this rerun). Deliver the next ready request without
  waiting for that outcome-proof run.
  The sub-agent then follows "Reading the outcome proof" below.
- **edit:** set Approval to Edit requested, apply the instruction, return the
  row through the identical owning-boundary verification gate, and ask again at
  the same position.
- **reject:** set Approval to Rejected and Fix to Dropped; never deploy that
  fix. The cluster keeps its position and needs a new RCA for a different
  approach.

The harness-fix decision does not satisfy any later prompt or terminal-behavior
admin approval. Those approvals are snapshot-scoped inside /deploy.

## Rerun and parallel deploy

On each approve, immediately start that cluster's outcome-proof run on the
**cloud fleet** (apply the fix in a local code snapshot / worktree, then
`scripts/run-bench <task> [<task>...]` — never `--local` unless Andy opted in).
Do not wait to batch approvals or rerun the whole failed subset first.
Run `/sync` before every subset or full-slice rerun. The final acceptance run
covers the entire original slice and also defaults to the cloud fleet.

For each approved HARNESS row, this is `/RCA`'s mandatory exact outcome-proof
run. Keep the prompt, evaluator, expected tools, fixture, timeout, and pass
criteria identical to the failing run except for the exact approved fix. Never
call the RCA complete from its owning-boundary proxy proof alone.

### What the outcome proof runs

- **Every member task of the cluster**, the exemplar and each sibling. The RCA
  and its repro were built on the exemplar, so the siblings are the held-out
  check that the fix removes the root cause rather than fitting one trajectory.
- **Up to three canaries:** tasks in the original slice whose latest accepted
  result is a pass, that share a `deploy_category` or tag with a member, and
  whose `scripts/descend_outcome_runs.py` line shows at least five `attempts`
  with `passes` equal to `attempts`. Run none when no task qualifies. Canaries
  are an executed subset; they never change the slice or its denominator.

### How many runs each task needs

```bash
python3 scripts/descend_outcome_runs.py <member-task> [<member-task>...]
```

It reads each task's last ten recorded attempts from
`agents/benchmarks/history/task_attempts.jsonl` and prints the passing runs
that task's proof requires:

| Passes in the recorded window | Required runs | Why                                                |
| ----------------------------- | ------------- | -------------------------------------------------- |
| None                          | 1             | The task never passes, so one pass is new behavior |
| Fewer than half               | 3             | It already passes sometimes without the fix        |
| Half or more                  | 5             | One pass is the likely result with no fix at all   |

That ledger records runs made from a checkout, so this descent's cloud-fleet
results are not in it: use at least 3 for a task this descent has itself seen
pass on unfixed code. A canary needs 1. Launch the tasks that need one run
together with `scripts/run-bench <tasks...>`, and each larger group with
`scripts/run-bench <tasks...> -k K --concurrency N`. Every required run must
pass. Do not rerun a failed proof to look for a pass, and do not lower a count
because the rerun is slow or costly.

### Reading the outcome proof

Classify every non-pass as INFRA or HARNESS first. An INFRA result is neither a
pass nor a failure of the fix: RCA it under the infra loop, then rerun only the
runs it denied.

- **Every member passes every required run and no canary fails:** set Real
  rerun to Confirmed and RCA to Complete, then enqueue the deploy unit.
- **The exemplar passes but a sibling fails:** the fix is real and the cluster
  was too wide. Split the failing siblings out, confirm the row for the tasks
  that passed, and enqueue its deploy unit. The split tasks return to
  TRIAGE_FAILURES with their post-fix run as primary evidence.
- **The exemplar fails a required run:** set Real rerun to Failed and rerun
  `/rca` for the cluster from that run. The cluster keeps its position.
- **A canary fails:** set Real rerun to Failed and name the regressed task in
  the Issue cell. The fix does not deploy until that failure is root-caused
  from the canary's run. If its RCA proves a cause independent of the fix, the
  canary becomes its own cluster and the original row is Confirmed.

A fix earns deployment only after:

- its local RCA repro passes unchanged;
- its test is cemented;
- Andy accepted it when it is a HARNESS fix; and
- a real benchmark rerun confirms the affected member tasks or infra boundary,
  with every required run passing and no canary failing.

Create one deploy unit per independent fix, or the smallest group of fixes that
must ship together. Run `/sync`, then record base_sha and exact fix_commits.
Prepare a clean isolated worktree containing only that unit and start a
background sub-agent running /deploy. This fix-only handoff is mandatory because
/deploy ships its entire worktree.

Before starting that worker, hydrate and provision the isolated worktree from
the controller. This creates a persistent child identity and collision-free
port range, links the controller's local credential files, installs missing
dependencies, and starts a Postgres container owned by the child worktree:

```bash
bash scripts/prepare-deploy-worktree.sh \
  --worktree "$DEPLOY_WORKTREE" \
  --source "$(git rev-parse --show-toplevel)"
```

Require this command to pass before the worker starts. Never run the controller's
`scripts/setup-db.sh` from the child: an inherited Conductor identity can reset
the controller database. Database cleanup or reclamation is a separate RCA; the
preflight fails closed instead of deleting an existing mismatched container.

The main controller does not block on deploys. It continues remaining RCAs and
reruns, actively tracks every deploy worker, and updates the lifecycle ledger.
If another deploy merges first, remaining deploy units sync origin/main and
rerun their required gates.

## Stop 2 — DEPLOY_ADMIN_APPROVAL

Each deploy unit runs /deploy's prompt and agent
recovery/terminal-behavior guards.

- If neither guard requires approval, preserve Fix approved for accepted HARNESS
  rows or set Not required for INFRA rows, then continue without stopping.
- If a guard requires approval, run the shared Golden-reference adversarial
  review. `GROUNDED` sets the rows to Deploy approved (golden review) and the
  deploy continues. Otherwise set all affected rows to
  Deploy approval, return the full packet to the main thread to show the exact
  snapshot-scoped diff, and pause only
  that deploy unit.
- After Andy approves that exact diff, set the rows to
  Deploy approved and resume the deploy.
- If a later change modifies an approval-gated hunk, return the affected deploy
  unit to Deploy approval with a new snapshot ID.

Credential, billing, quota, review-service, or provider failures remain scoped
deploy blockers. Continue unrelated work and show the blocker in Deployed;
do not turn them into ad hoc prioritization questions.

## Response contract

Read `.claude/shared/benchmark-report-format.txt`, or retrieve it with
`scripts/run-bench report-format`. It is the sole scorecard contract; render
each card with `scripts/run-bench scorecard <run-dir> --html <file>` and publish
that output instead of hand-writing it; preserve
the Experiment Number in the first row, experiments/day for this goal, and
the last three experiments with concise timing, queue/verdict, cost/cache/latency
and lifecycle subrows. Preserve the frame, denominators and active-worker lines;
remove the old standalone active-run/progress/metrics and last-slice blocks. Never
display nulls or empty sentinels: use a concrete coverage state or an evidenced
milestone estimate, and use `warming <age>` for incomplete rate history rather
than fabricated zeroes. On boxes.dev publish only the rendered HTML card; the
`--text` fallback is one fenced `diff` block with no surrounding narrative. Apply the shared
LIFE far-right column (no UPD or progress wheels), verified rolling 15-minute rate and stall rules.

The scorecard describes the latest concrete slice, not every background proof
run combined. In ISSUES / NEXT ACTION keep these compact lines when a subset
is executing:

- `Overall slice: <passed_original>/<total_original> passed` — original names,
  fixed denominator and each task's latest trustworthy result.
- `Latest run: <passed_run>/<total_run> passed` — exact executed subset and its
  actual start, terminal time or elapsed duration. Bench run times come from
  producer artifacts, not observation timestamps.

Never put the latest subset denominator in the Overall slice field. Separate
sampling goals preserve every slice's own task list and acceptance disposition;
a new sample never rewrites the original run.

### Cluster and approval status

The full lifecycle ledger remains in `state.json`. Every row records ID, kind,
issue class, exact member names/count, concrete first-bad boundary, RCA status,
fix/test proof, approval snapshot/decision, real rerun and deploy status.
Show changed or blocked clusters briefly in ISSUES / NEXT ACTION, including
owner, boundary and proof/approval state. Use one active-worker line per agent,
with its actual start/block timestamp and age. Pending runtime/deploy approval
is not marked as blocking the next slice unless that exact action is a genuine
resource/authorization dependency. Show the infra hold's original start/age.

For each terminal run record both task success and infra reliability. A below 5%
infra result allows the next slice; it does not mean all tasks passed, all fixes
are proven or all resources released. Recovery/proof attempts and errors stay
visible even when their failure is accepted for a separate infrastructure goal.

### Main-thread approvals

All HARNESS_FIX_DECISION and DEPLOY_ADMIN_APPROVAL requests are emitted by the
main thread using `.claude/shared/approval-format.md`, separate from progress
cards, only after its Golden-reference adversarial review did not clear them. Read that file completely before composing a request. Use its seven
sections (How: immediately before TL;DR:), exact inline diff, durable
failing-run evidence, pre/post causal measurements, golden reference, full
unchanged exemplar task prompt, required Links list and explicit decision
syntax (`Approve: <row ID> approve`).

The core claim identifies the issue class and proven first-bad boundary: the
issue is the measured root cause, not a timeout label. State the wrong observed
value, expected value and identical repro now passing. Label the packet
Causal proof; outcome pending when benchmark verification is deferred until
approval. Do not imply that causal proof guarantees the benchmark will pass.
List each member's own observed boundary evidence, exact task name, FE evidence
and required proof runs; a sibling count alone is insufficient.

Use one complete approval block and ID per independent snapshot decision. Two
ready runtime clusters can have two separate requests in the main thread;
never bundle their diffs under one blanket approval or hide the second behind
an unanswered independent request. Record each delivered request and decision
in state. Duplicate cluster occurrences update the same request/ledger row;
changed gated hunks need a new snapshot decision. No human fix request is
created for an ordinary INFRA repair.

The main thread continues monitoring, infra repair and authorized next slices
while decisions are pending. Only the affected candidate or deploy action
waits. Report Completed benchmark goal separately from RCA/outcome/deploy
completion; a progress card or approval request does not end authorized work.

## Done

Completion follows the persisted user goal. For an ordinary descent:

- every original task has a trustworthy pass on a full-slice acceptance rerun;
- every in-scope owned error cluster has been repaired and its required causal
  and outcome proofs are complete, or has an explicitly recorded unresolved
  disposition accepted by the user;
- every RCA repro is cemented in its owning consistently-run suite;
- every accepted and real-rerun-confirmed fix is deployed and production-verified;
- no required approval, outcome proof or deploy unit remains unfinished; and
- controller exit, final publication and exact resource release are verified,
  with the full ledger and measured duration preserved and the final scorecard
  emitted.

An explicitly infrastructure-only or consecutive-slice goal uses the user's
acceptance rule, retaining genuine task FAILs and actual infra rates. Do not
add a zero-infra goal, a full-financial-proof goal or another acceptance gate.
Goal credit never substitutes for outcome proof or verified resource release.
Keep remaining authorized repairs/deploys moving and label their state honestly.
Do not enable a cron or expand the paid workload without a user request.

For fleet publication/cleanup regressions, follow the canonical benchmark CLI
and `scripts/tests/benchmark-live-results.test.py`, not a private replacement
harness. Distinguish an evaluated verdict from resource release: the parent stays
live through teardown. Follow the Operations Runbook for any explicitly authorized temporary
execution setting; keep normal defaults and exact ownership cleanup unchanged.
