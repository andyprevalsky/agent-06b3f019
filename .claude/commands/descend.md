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

## Hard rules

1. **No reward hacking.** Never change a benchmark definition, prompt, expected
   tools, pass criteria, load size, timeout, concurrency, price cap, or
   production behavior merely to make it pass. Never weaken a repro assertion
   or hide a failed primary path behind a fallback. If a task contract appears
   wrong, do not edit it; represent that proposal as a HARNESS row at
   HARNESS_FIX_DECISION.
2. **No RCA without the hard proof pair.** A completed RCA requires a local
   repro actually observed failing on the buggy code and the identical repro
   passing after the fix, with the assertion unchanged. Otherwise its status is
   Open observability gap.
3. **Every fix is cemented.** Promote the repro into the consistently-run suite
   that owns the first-bad boundary.
4. **Actively drive asynchronous work.** Poll benchmark controllers and deploy
   workers on the CLAUDE.md cadence. Check both output growth and liveness.
   Never fire and passively wait.
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

## Resolve the slice

For daily, pre-deploy, rose-bench, or incomplete, resolve the exact concrete
task list using deriveTaskGroup / resolveTaskGroup in
back-end/src/domains/benchmarks/hubCatalogService.ts against
agents/benchmarks/tasks.json. Print the resolved list and count before running.

For explicit task names, use them verbatim. The reported slice must exactly
equal the executed slice; never silently add, remove, fold in, or substitute
another workstream's results.

## Persistent state

Create .context/descend/<run-id>/state.json and update it after every state
transition. It must contain:

- slice name and exact task list;
- controller PID, dashboard, run artifact, agent IDs, and FE links;
- current state and epoch;
- actual benchmark started_at, finished_at, and duration;
- one lifecycle record per issue/fix;
- infra RCA ledger across all epochs;
- `/sync` checkpoint timestamp, pre/post base SHA, origin/main SHA, DB-resync
  result, conflicts resolved, and affected regression gates;
- Andy decisions and approval snapshot IDs;
- deploy unit base SHA, exact fix commits, worktree, worker ID, PR, and status.

Compaction, session restart, or a sub-agent response must not erase or recreate
state from memory.

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

Do not stop to ask which RCA to run first. Use all safe parallel capacity.

## Stop 1 — HARNESS_FIX_DECISION

Enter this state only when:

- the latest benchmark run is infra-clean; and
- every HARNESS failure has a completed RCA; and
- all independent RCA workers have returned.

Never enter HARNESS_FIX_DECISION with an open observability gap. If evidence is
incomplete, remain in RCA_HARNESS_FAILURES_IN_PARALLEL and keep gathering it
autonomously until every RCA has the unchanged failing/passing proof pair and a
cemented regression test. An exhausted external blocker follows Hard rule 7;
it does not become a user-response gate.

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
header count. Emit exactly one table row per issue/fix, including the full infra
ledger and current HARNESS fixes.

### Header

Use a Markdown heading and a human-readable status. The only status labels are:
- 🟢 Descending
- 🟡 Fix approval needed
- 🟠 Deploy approval needed
- ✅ Complete
- 🔴 Blocked

Put the run result and benchmark timing directly beneath it. Read timing from
the controller artifact; never estimate it.

For a completed run:

## /descend daily
### 🟡 Fix approval needed

**Epoch 3** · **39/42 passed** · **42m 46s**

Bench run: **Jul 20, 2026 · 10:14:22–10:57:08 PDT**

For an active run, show the actual start timestamp and elapsed duration:

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

| ID | Kind | Issue (≤100 chars) | RCA | Fix | Test | Approval | Real rerun | Deploy |
|---|---|---|---|---|---|---|---|---|
| H-01 | HARNESS | Browser agent failed to start because proxy generation returned HTTP 400 | ✅ Complete | ✅ Passes | ✅ Cemented | ⏳ Fix approval | ⏳ Pending | — Not queued |

Lifecycle values:

- **RCA:** ✅ Complete | ⚠️ Open gap
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
⏳ Fix approval. Use this exact five-part narrative and keep every value
concrete:

### <row ID> · <issue summary>

The issue is **<root cause at the first-bad boundary>**. I reproduced it with
**<minimal local test and exact command>**, where we measured **<measurement>**
and observed **<wrong result>** instead of **<expected result>**. I fixed it by
**<specific implementation change>**. The unchanged local repro now
**<exact passing result>**, and the regression is cemented in
**<permanent test name>**.

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

This deploy changes **<one-line prompt or terminal-behavior effect>**. The exact
snapshot-scoped diff is **<diff reference or displayed hunk>**.

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
