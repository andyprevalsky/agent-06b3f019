---
description: "Descend on a benchmark slice to 100% green with zero reward hacks: run, fix infra, RCA harness failures in parallel, stop for fix decisions, rerun, and async-deploy confirmed fixes with a second stop only for required admin approval."
argument-hint: "<slice> — daily | pre-deploy | rose-bench | incomplete, or explicit task names"
---

# /descend

**North star: every task in the resolved slice passes on a real, infra-clean
rerun with zero reward hacks, and every confirmed fix is deployed.**

This command composes /benchmark, /rca, and /deploy. Read
benchmark.md, rca.md, and deploy.md completely before starting. This file owns
their orchestration, state, user-input gates, and response contract.

## Canonical human-approval format

Both planned user-input gates, and any unplanned human approval permitted by
the composed commands, must follow `.claude/shared/approval-format.md`.
Read it completely immediately before composing the request. The
response-contract fields below add benchmark and lifecycle context, but never
replace the shared Detail, Before Behavior, After Behavior, and Downstream
Implications sections.

## Hard rules

1. **No reward hacking.** Never change a benchmark definition, prompt, expected
   tools, pass criteria, load size, timeout, concurrency, price cap, or
   production behavior merely to make it pass. Never weaken a repro assertion
   or hide a failed primary path behind a fallback. If a task contract appears
   wrong, do not edit it; represent that proposal as a HARNESS row at
   HARNESS_FIX_DECISION.
2. **No RCA without the hard proof pair.** Before any benchmark rerun, the RCA
   must have a local owning-boundary repro actually observed failing on the
   buggy code and the identical repro passing after the fix, with the assertion
   unchanged. For a benchmark failure, that is causal proof—not the final
   outcome proof. The RCA becomes outcome-complete only after the exact
   unchanged post-fix benchmark rerun passes. Otherwise its status is Causal
   proof; outcome pending, or Open observability gap when causal proof is absent.
3. **Every fix is cemented.** Promote the repro into the consistently-run suite
   that owns the first-bad boundary.
4. **Actively drive asynchronous work.** Poll benchmark controllers and deploy
   workers on the CLAUDE.md cadence. Check both output growth and liveness.
   Never fire and passively wait.
4a. **Zero started tasks after 5 minutes is a fault, not a slow start.** A
   generous configured budget is never evidence of progress. If a run has
   produced no task in a started/running state 5 minutes after launch, stop
   treating elapsed time as normal: poll every 60 seconds and, on every poll,
   prove liveness from the WORK ITSELF — never from the controller's own
   "waiting" line. A controller printing `still waiting (Ns): status=none` is
   reporting its own patience, not the guest's health, and a dashboard showing
   `queued` only means no result was ever produced. Each poll must show at
   least one of: a task state transition, the guest driver's state file/log
   advancing, or a clean guest process check. Pull the guest's own evidence —
   driver state, driver exit code, `dmesg` for `oom-kill`/`Killed process`. If
   the same wait line repeats with no underlying state change, classify the run
   INFRA-failing, capture on-guest evidence BEFORE teardown destroys it, then
   stop the run rather than let it burn. Never report a run that never started
   as healthy boot progress.
5. **Infra is in scope.** RCA and fix every harness, fleet, credential plumbing,
   capacity, teardown, and control-plane failure. Never kill a benchmark fleet
   not launched by this session.
6. **Exactly two planned user-input gates.** The only planned points that may
   stop for Andy are HARNESS_FIX_DECISION and DEPLOY_ADMIN_APPROVAL. Do not ask
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
9. **Pin one issue cluster per row.** Classify at the proven first-bad boundary
   using the taxonomy below. If two independent clusters caused one task
   failure, split them into separate lifecycle rows. Never use a downstream
   symptom such as “timeout” when the RCA proves a deeper cluster.
10. **Time every state and parallel lane.** Use `scripts/descend_step_log.py`
    at every state boundary. Completed timings go to the tracked
    `agents/benchmarks/history/descend_steps.jsonl` ledger; `.context` holds
    only active clocks. A state transition is incomplete if its timing command
    did not succeed.
11. **RCA before benchmark rerun.** Every failed task must enter its own `/RCA`
   cycle before any benchmark rerun. Gather the runtime evidence, identify the
   first-bad boundary, run the unchanged owning-boundary repro red then green,
   and cement it first. A HARNESS fix must then have Andy's fix approval before
   the exact post-fix benchmark rerun; an INFRA fix does not require approval.
   That exact rerun supplies `/RCA`'s benchmark outcome proof and is what moves
   the RCA from Causal proof; outcome pending to Complete. When the slice is
   executed one task at a time, finish this full RCA → approval when required →
   exact rerun cycle before starting another original-slice task.
12. **Approval format is the ONLY response format — no exceptions.** Every
   response emitted while `/descend` is active MUST consist of exactly: the
   header block, the lifecycle table, and — only at a stop — the approval
   sections defined in the response contract. Nothing else may appear. No
   free-form prose report, no narrative of what you did, no "what I found"
   essay, no recap of completed work, no bulleted list of open items outside
   the table, no explanation of a fix outside its own approval section, no
   commentary on sub-agent results. If a fact does not fit in the header, a
   table cell, or a required approval section, it is not said in chat —
   evidence belongs in the RCA and the commit message.
   **Single exception:** inside a deploy approval gate you may additionally show
   the exact file diff or file content under review, because a human cannot
   approve a snapshot they cannot see.
   Be as concise as possible without losing critical information: preserve the
   measurement, the wrong value, the expected value, and the file link; cut
   everything else. Never pad.

## Issue clusters

Every lifecycle row has exactly one `issue_cluster`, rendered verbatim in the
Cluster column. This is the user-facing core claim; the deeper RCA problem
bucket may remain more technical.

| Issue cluster | Use when the proven first-bad boundary is… |
|---|---|
| **Faulty Evaluator** | Evaluator code, checks, criteria, rubric, or verifier-scoring instructions disagree with the authoritative task contract—including task-versus-evaluator conflicts—or accept an outcome that contract forbids. |
| **Prompting Inconsistency** | Two instructions governing the acting agent before evaluation—task, system/tool prompt, or tool/response schema—contradict each other. Evaluator-only scoring conflicts are excluded. |
| **Underspecified Task** | A requirement or preference needed for a unique correct outcome is absent from the task contract. |
| **Context Drift** | Relevant context becomes stale, truncated, overwritten, cross-contaminated, or detached from the action it should govern. |
| **Lacking Tool** | No available tool or capability can observe or perform a required action. |
| **Broken Tool** | The required tool exists, but errors, stalls, returns invalid data, or violates its contract. |
| **Product Defect** | Owned application, service, workflow, or state-transition logic violates a valid contract after inputs and tool delivery are correct. |
| **Agent Reasoning Failure** | Prompt, context, tools, data, and evaluator are valid, but the agent chooses or reports the wrong action or result. |
| **Fixture/Data Mismatch** | Seed data, identity, account state, credentials, or the benchmark environment contradicts the task contract. |
| **Resource/Performance Failure** | Owned context growth, cost, memory, concurrency, or timeout policy prevents otherwise valid progress. |
| **External Blocker** | A third-party outage, policy block, CAPTCHA, or rate limit prevents completion after owned recovery behavior works correctly. |
| **Infrastructure Failure** | Fleet, queue, port, build, credential plumbing, teardown, or control-plane behavior prevents a trustworthy verdict. |
| **Observability Gap** | Required evidence is not captured, so no deeper completed classification is yet supportable. |
| **Other** | None fits after proof; name the proposed new reusable cluster in the RCA so this taxonomy can be extended. |

Boundary rules resolve overlaps: every evaluator-side disagreement with the
authoritative task—including criteria later injected into a verifier prompt—is
Faulty Evaluator. Prompting Inconsistency is reserved for contradictory
instructions governing the acting agent before evaluation. A missing
requirement is Underspecified Task; an absent capability is Lacking Tool; and an
existing malfunctioning capability is Broken Tool. If a tool successfully
delivers valid input but owned application state changes incorrectly, use
Product Defect. Do not call an owned broken recovery path an External Blocker
merely because a third party triggered it.

Map the deeper `/rca` problem buckets into the one-glance clusters as follows:

| `/rca` problem bucket | `/descend` issue cluster |
|---|---|
| Timeout too aggressive | Resource/Performance Failure |
| Logical inconsistency in harness prompts/contracts | Faulty Evaluator for every evaluator-versus-task scoring conflict; Prompting Inconsistency only for contradictory instructions governing the acting agent before evaluation |
| Uncaptured user preference/spec | Underspecified Task |
| New tool/capability required | Lacking Tool |
| Concurrency inefficiency | Resource/Performance Failure |
| Fixture/environment/data mismatch | Fixture/Data Mismatch, or Infrastructure Failure when no trustworthy task verdict exists |
| Observability/trace capture gap | Observability Gap |
| Other | Reclassify from the proven first-bad boundary, normally Product Defect, Broken Tool, Agent Reasoning Failure, External Blocker, or Infrastructure Failure; retain Other only when proposing a new reusable cluster |

## Resolve the slice

For daily, pre-deploy, rose-bench, or incomplete, resolve the exact concrete
task list using deriveTaskGroup / resolveTaskGroup in
back-end/src/domains/benchmarks/hubCatalogService.ts against
agents/benchmarks/tasks.json. Print the resolved list and count before running.

For explicit task names, use them verbatim. The reported slice must exactly
equal the originally requested and resolved task set; never silently add,
remove, fold in, or substitute another workstream's results. Executing that
slice one task at a time, rerunning a failed subset, or running a diagnostic
subset does not change the original slice name, task list, or denominator.
Record and report every executed subset separately from overall slice progress.

## Persistent state

Create .context/descend/<run-id>/state.json and update it after every state
transition. It must contain:

- original resolved slice name, exact task list, and total task count;
- latest executed subset and its exact task list;
- cumulative latest accepted status for every original task;
- controller PID, dashboard, run artifact, agent IDs, and FE links;
- current state and epoch;
- actual benchmark started_at, finished_at, and duration;
- one lifecycle record per issue/fix;
- the exact issue_cluster for every lifecycle record;
- infra RCA ledger across all epochs;
- `/sync` checkpoint timestamp, pre/post base SHA, origin/main SHA, DB-resync
  result, conflicts resolved, and affected regression gates;
- Andy decisions and approval snapshot IDs;
- deploy unit base SHA, exact fix commits, worktree, worker ID, PR, and status;
- active timing lanes, their current steps, and the last completed timing
  record ID.

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

~~~bash
python3 scripts/descend_step_log.py start \
  --run-id "$RUN_ID" --slice "$SLICE" \
  --lane main --step RESOLVE_SLICE --epoch "$EPOCH"
~~~

At every main state boundary, close the old state and start the new state with
one command. Use the exact state-machine label, including repeated states in a
new epoch:

~~~bash
python3 scripts/descend_step_log.py transition \
  --run-id "$RUN_ID" --lane main \
  --step SYNC_CHECKPOINT --epoch "$EPOCH" --task-count "$TASK_COUNT"
~~~

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

~~~bash
python3 scripts/descend_step_log.py start \
  --run-id "$RUN_ID" --slice "$SLICE" --task-count "$TASK_COUNT" \
  --lane rca-I-03 --step RCA_INFRA_FIX --epoch "$EPOCH"
python3 scripts/descend_step_log.py finish \
  --run-id "$RUN_ID" --lane rca-I-03 --status completed
~~~

When the controller reaches `DONE` or `BLOCKED`, transition into that terminal
state first so it gets its own row, then close the main lane with
`--run-terminal` so wall-clock trends include the run. Use `--status completed`
for `DONE` and `--status blocked` for `BLOCKED`:

~~~bash
python3 scripts/descend_step_log.py transition \
  --run-id "$RUN_ID" --lane main --step DONE --epoch "$EPOCH"
python3 scripts/descend_step_log.py finish \
  --run-id "$RUN_ID" --lane main --status completed --run-terminal
~~~

Before every `/sync`, commit any newly appended ledger rows in a log-only
commit so merging cannot discard them. Commit only the ledger path; never fold
unrelated work into that commit. After closing the terminal main lane, commit
the remaining rows before the final response. `DONE` and `BLOCKED` are invalid
while this ledger has uncommitted rows for the current run.

After each full-slice acceptance attempt and at the terminal boundary, analyze
the recent window against the preceding window. Negative change is faster;
positive change is a regression to investigate:

~~~bash
python3 scripts/descend_step_log.py report \
  --slice "$SLICE" --task-count "$TASK_COUNT" \
  --lane main --status completed --window 5
~~~

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
does not substitute for workers on a different base SHA.

Before syncing a dirty controller workspace, persist `state.json` and preserve
all in-progress work reversibly. Never discard it to make the merge succeed.
Resolve conflicts by retaining current main behavior and integrating the descent
changes on top, restore the preserved work, run the tests that own every touched
boundary, then record the checkpoint evidence in `state.json`. A failed or
incomplete `/sync` blocks that RCA, rerun, or handoff—not unrelated active work.

## State machine

~~~text
RESOLVE_SLICE
  → SYNC_CHECKPOINT → RUN_SLICE
  → CLASSIFY_RESULTS
      ├─ INFRA found → SYNC_CHECKPOINT_PER_RCA → RCA_INFRA_FIX
      │                   → VERIFY_LOCAL → SYNC_CHECKPOINT → RUN_SLICE
      │                   └─ real rerun confirms fix → ENQUEUE_DEPLOY_UNIT ─┐
      └─ infra-clean → SYNC_CHECKPOINT_PER_RCA                        │
                           → RCA_HARNESS_FAILURES_IN_PARALLEL → VERIFY_LOCAL
                           → HARNESS_FIX_DECISION              [STOP 1]     │
                           → APPLY_HARNESS_DECISIONS                        │
                           → SYNC_CHECKPOINT → RERUN_FAILED_SUBSET          │
                                ├─ still failing → CLASSIFY_RESULTS         │
                                └─ confirmed fix → ENQUEUE_DEPLOY_UNIT ─────┤
                                                                            │
MAIN:   continue every independent RCA and rerun ◀───────────────────────────┘

DEPLOY: prepare isolated fix-only worktree → /deploy
        ├─ no admin approval required → merge → verify production
        └─ admin approval required → DEPLOY_ADMIN_APPROVAL       [STOP 2]
                                   → merge → verify production

FULL_SLICE_ACCEPTANCE
  ├─ any non-pass → CLASSIFY_RESULTS
  └─ all pass + every deploy merged → DONE → propose/enable cron
~~~

HARNESS_FIX_DECISION pauses the main controller. DEPLOY_ADMIN_APPROVAL pauses only
the affected deploy unit while the controller continues every independent RCA,
rerun, and deploy. If no independent work remains, the controller may wait for
that deploy approval.

User input can be injected at any time and is applied at the next safe boundary,
but the agent deliberately yields for input only in the two states above.

## Benchmark and infra-clean loop

Run only through the isolated entrypoint:

~~~bash
scripts/run-bench <resolved task names...>
~~~

Capture the controller PID, dashboard, artifact path, actual start/finish
timestamps, and every agent FE link. Actively monitor until every requested
benchmark has a terminal result and verify every FE link renders.

Classify every non-pass as exactly one of:

- **INFRA:** the harness/fleet/runtime environment failed before the agent could
  receive a trustworthy task verdict.
- **HARNESS:** the benchmark reached a trustworthy agent/evaluator verdict, but
  the agent or product path failed the real pass criteria. A fallback or silent
  substitute that masks the required path is a HARNESS failure.

The infra loop is strict:

~~~text
while the latest run contains any INFRA result:
    run /sync immediately before each distinct /RCA
    RCA every distinct infra issue
    reproduce locally
    implement the root-cause fix
    rerun the identical repro
    cement the test
    append/update its lifecycle row
    run /sync before rerunning the slice
    rerun the slice
~~~

Do not stop for Andy, issue harness verdicts, or present fix decisions from an
infra-dirty run. A newly discovered infra failure begins another infra epoch.
Once a real rerun confirms an infra fix, its deploy unit may start in parallel
with the remaining descent.

## HARNESS RCA

Only after an infra-clean run:

1. Gather runtime evidence first: run artifacts, worker/backend logs,
   agent_latency.py, agent_logs.py, DB, and relevant HTTP evidence.
2. Run `/sync` immediately before every distinct `/RCA`, then run independent
   HARNESS RCAs in parallel when file ownership does not conflict. Sync each
   isolated RCA worktree before its worker starts. Group dependent failures
   under one root-cause RCA.
3. Produce the local failing repro.
4. Implement the root-cause fix.
5. Run the identical repro and observe it pass.
6. Cement the repro.
7. Update exactly one lifecycle row per issue/fix.
8. Assign exactly one issue cluster from the pinned taxonomy and record the
   exact, untruncated `task.prompt` for every HARNESS row.

At this boundary the owning-boundary RCA is causally proven, but the benchmark
RCA is not outcome-complete yet. Do not run the exact benchmark here and do not
label the row Complete. Enter HARNESS_FIX_DECISION with Causal proof; outcome
pending. After approval, the exact unchanged benchmark rerun either supplies
the missing outcome proof and completes the RCA or becomes new primary evidence
that returns the row to CLASSIFY_RESULTS.

Do not stop to ask which RCA to run first. Use all safe parallel capacity.

## Stop 1 — HARNESS_FIX_DECISION

Enter this state only when:

- the latest benchmark run is infra-clean; and
- every HARNESS failure has complete causal RCA proof (evidence, unchanged
  owning-boundary repro red then green, and a cemented test); and
- all independent RCA workers have returned.

Never enter HARNESS_FIX_DECISION with an open observability gap. If evidence is
incomplete, remain in RCA_HARNESS_FAILURES_IN_PARALLEL and keep gathering it
autonomously until every RCA has the unchanged owning-boundary failing/passing
proof pair and a cemented regression test. The exact post-fix benchmark outcome
remains explicitly pending until after Andy approves the harness fix. An
exhausted external blocker follows Hard rule 7; it does not become a
user-response gate.

Emit the complete sorted lifecycle ledger using the response contract below.
Andy responds to each HARNESS row with approve, edit, or reject. Infra rows use
Not required.

- **approve:** set Approval to Fix approved.
- **edit:** set Approval to Edit requested, apply the instruction, and
  return the row through the identical local verification gate.
- **reject:** set Approval to Rejected and Fix to Dropped; never deploy that fix.

The harness-fix decision does not satisfy any later prompt or terminal-behavior
admin approval. Those approvals are snapshot-scoped inside /deploy.

## Rerun and parallel deploy

Rerun at least the previously failing subset after applying Andy's decisions.
Run `/sync` before every subset or full-slice rerun. The final acceptance run
covers the entire original slice.

For each approved HARNESS row, this is `/RCA`'s mandatory exact outcome-proof
run. Keep the prompt, evaluator, expected tools, fixture, timeout, and pass
criteria identical to the failing run except for the exact approved fix. A pass
moves RCA to Complete and Real rerun to Confirmed. A failure moves Real rerun to
Failed and returns to CLASSIFY_RESULTS; never call the RCA complete from its
owning-boundary proxy proof alone.

A fix earns deployment only after:

- its local RCA repro passes unchanged;
- its test is cemented;
- Andy accepted it when it is a HARNESS fix; and
- a real benchmark rerun confirms the affected task or infra boundary.

Create one deploy unit per independent fix, or the smallest group of fixes that
must ship together. Run `/sync`, then record base_sha and exact fix_commits.
Prepare a clean isolated worktree containing only that unit and start a
background sub-agent running /deploy. This fix-only handoff is mandatory because
/deploy ships its entire worktree.

Before starting that worker, hydrate and provision the isolated worktree from
the controller. This creates a persistent child identity and collision-free
port range, links the controller's local credential files, installs missing
dependencies, and starts a Postgres container owned by the child worktree:

~~~bash
bash scripts/prepare-deploy-worktree.sh \
  --worktree "$DEPLOY_WORKTREE" \
  --source "$(git rev-parse --show-toplevel)"
~~~

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
- If a guard requires approval, set all affected rows to
  Deploy approval, show the exact snapshot-scoped diff, and pause only
  that deploy unit.
- After Andy approves that exact diff, set the rows to
  Deploy approved and resume the deploy.
- If a later change modifies an approval-gated hunk, return the affected deploy
  unit to Deploy approval with a new snapshot ID.

Credential, billing, quota, review-service, or provider failures remain scoped
deploy blockers. Continue unrelated work and show the blocker in Deployed;
do not turn them into ad hoc prioritization questions.

## Response contract

Every /descend response uses real rendered Markdown. Never put the header,
lifecycle table, or approval content in a code block. Do not include an ASCII
banner, an infra 0 field, or a LANES section. Passing tasks collapse into the
overall-slice header count. Emit exactly one table row per issue/fix, including
the full infra ledger and current HARNESS fixes.

**This contract is exhaustive, not a minimum (Hard rule 12).** A response
contains the header, the lifecycle table, and — at a stop only — the approval
sections below. It contains nothing else. Do not append a summary, a status
narrative, a list of what is still open, or any prose outside an approval
section; the table already carries that state. The only permitted addition is
the file diff or file content shown inside a deploy approval gate. Keep every
required field as short as it can be while preserving the measurement, the
wrong value, the expected value, and the file link.

### Header

Use a Markdown heading and a human-readable status. The only status labels are:
- 🟢 Descending
- 🟡 Fix approval needed
- 🟠 Deploy approval needed
- ✅ Complete
- 🔴 Blocked

Put overall original-slice progress first, then the latest run result and
benchmark timing directly beneath it. Read latest-run counts and timing from
the controller artifact; never estimate them.

`total_original` is fixed when the requested slice is first resolved.
`passed_original` is the number of distinct original tasks whose latest
accepted, infra-clean, real result in this descent is a pass. A later accepted
failure replaces an earlier pass for that task. `passed_run` and `total_run`
describe only the latest executed subset.
Never put the latest subset denominator in the Overall slice field.

Use these two labeled lines in every active, stopped, blocked, and completed
response:

Overall slice: **<passed_original>/<total_original> passed**

Latest run: **<passed_run>/<total_run> passed** · **<actual duration>**

For a completed run:

## /descend daily
### 🟡 Fix approval needed

**Epoch 3**

Overall slice: **39/42 passed**

Latest run: **3/3 passed** · **42m 46s**

Bench run: **Jul 20, 2026 · 10:14:22–10:57:08 PDT**

For an active run, keep both denominators visible and show the actual start
timestamp and elapsed duration:

Overall slice: **36/42 passed**

Latest run: **2/3 passed** · **18m 42s elapsed**

Bench run: **Started Jul 20, 2026 · 10:14:22 PDT** · **18m 42s elapsed**

### Ledger order

Re-sort the entire ledger on every response:

1. Rows with ⏳ Deploy approval first, ordered by row ID.
2. Rows with ⏳ Fix approval next, ordered by row ID.
3. All other rows not yet deployed next, ordered by row ID.
4. Rows with ✅ Deployed #<PR> last, ordered by deployment completion timestamp.

### Lifecycle table

The Issue cell is one line and at most 100 characters. It states the concrete
observed failure, not the benchmark's goal. Prefer boundary-specific summaries
such as "Browser agent failed to start because proxy generation returned HTTP
400." Render the ledger as a real Markdown table. Andy and Admin are the same
person, so there is exactly one Approval column.

| ID | Kind | Cluster | Issue (≤100 chars) | RCA | Fix | Test | Approval | Real rerun | Deploy |
|---|---|---|---|---|---|---|---|---|---|
| H-01 | HARNESS | Broken Tool | Browser agent failed to start because proxy generation returned HTTP 400 | ✅ Complete | ✅ Passes | ✅ Cemented | ⏳ Fix approval | ⏳ Pending | — Not queued |

Lifecycle values:

- **RCA:** ✅ Complete | 🧪 Causal proof; outcome pending | ⚠️ Open gap
- **Fix:** ✅ Passes | ⏳ In progress | 🗑 Dropped
- **Test:** ✅ Cemented | ⏳ Pending | — Not applicable for an open gap
- **Approval:** ⏳ Fix approval | ✅ Fix approved | ✏️ Edit requested |
  ❌ Rejected | ⏳ Deploy approval | ✅ Deploy approved | — Not required
- **Real rerun:** ⏳ Pending | ✅ Confirmed | ❌ Failed
- **Deploy:** — Not queued | ⏳ Testing | 🔎 Review |
  🚫 Blocked: <reason> | ✅ Deployed #<PR>

RCA, Fix, and Test cells may link to compact evidence, but may not contain logs
or multi-line explanations.

### Stop 1 content — fix approval

After the lifecycle table, include one section per HARNESS row with
⏳ Fix approval. Lead with the complete benchmark task and the one-glance core
claim, then use the canonical four-part approval narrative from
`.claude/shared/approval-format.md`. Never truncate, summarize, or paraphrase
`task.prompt`, even when it is long or multiline:

### <row ID> · <issue summary>

**Exact benchmark task (`task.prompt`, verbatim):**

> <full exact task.prompt with every line and character preserved>

#### Detail

**Core claim:** This task failed because **<issue cluster>**. <One or two plain
sentences describing the exact mismatch or failure; expand internal names such
as write_lock into ordinary language.>

The issue is **<root cause at the first-bad boundary>**. I reproduced it with
**<minimal local test and exact command>**, where we measured **<measurement>**
and observed **<wrong result>** instead of **<expected result>**.
The unchanged local repro now **<exact passing result>**, and the regression is
cemented in **<permanent test name>**. Include the approval snapshot and
clickable links to every affected hunk.

#### Before Behavior

<Trigger, ordering, measured wrong result, and user-visible failure before the
fix.>

#### After Behavior

<The same trigger and ordering after the fix, including the measured passing
result and what remains unchanged.>

#### Downstream Implications

<Affected tasks, users, agents, services, data/cost/security impact, rollback,
and 10k-agent behavior.>

**Is this fix approved?**

- **Approve:** <row ID> approve
- **Request an edit:** <row ID> edit: <instruction>
- **Reject:** <row ID> reject

Do not replace the reproduction measurement with vague language such as
“the test failed.” State what was measured, the wrong observed value, and the
expected value.

### Stop 2 content — deploy approval

After the affected lifecycle rows, include:

## Deploy approval needed

### A-<id> · <row IDs>

#### Detail

This deploy changes **<one-line prompt or terminal-behavior effect>**. Name the
exact unchanged test or reproduction that failed before and passes after the
change, its concrete results, the approval snapshot ID, and clickable links to
every affected hunk.

#### Before Behavior

<The exact prompt or terminal behavior before this deploy.>

#### After Behavior

<The exact prompt or terminal behavior after this deploy.>

#### Downstream Implications

<Affected tasks, users, agents, services, data/cost/security impact, rollback,
and 10k-agent behavior.>

**Is this deploy change approved?**

- **Approve:** A-<id> approve
- **Reject:** A-<id> reject: <reason>

For non-blocking progress, use 🟢 Descending and omit all approval questions.
For either stop, use the corresponding approval-needed status. Never end a
running response with a question. Put any resisted reward-hacking note directly
below the affected approval narrative.

## Done

Done requires all of:

- at least one real run completed with zero infra failures;
- every original task passed on a full-slice acceptance rerun;
- every RCA repro is cemented in a consistently-run suite;
- every accepted and real-rerun-confirmed fix is deployed and production-verified;
- no deploy unit remains testing, in review, blocked, or awaiting approval;
- the full lifecycle ledger and actual benchmark duration were reported.

Only then propose or enable the cron.
