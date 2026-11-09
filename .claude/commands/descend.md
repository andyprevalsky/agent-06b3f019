---
description: "Run a benchmark slice on the cloud fleet in batches, start one self-deduplicating /RCA per failed task, iterate until the slice reaches a 95% pass rate, then /deploy with one final change review."
argument-hint: "<slice> — first N polar tasks | daily | pre-deploy | rose-bench | polar-bench | incomplete | explicit task names"
---

# /descend

The one benchmark and experiment iteration loop. Read `/benchmark`, `/rca` and `/deploy` first, including before every launch a delegated owner makes; this command owns only their orchestration, state and response.

## Done

One full-slice run reaches a 95% pass rate (passing copies over scored copies, every task at every `-k` copy); then start `/deploy`, whose approval step is the only review (**Final change review**). Infra-only or consecutive-slice goals use the user's own acceptance rule; never add another gate. Start the descent with `/goal` on the slice reaching 95%.

## Process

| # | State | Step | Command |
|---|-------|------|---------|
| 1 | `RESOLVE_SLICE` | Start the clock, then resolve the slice and freeze its names, count and goal in state | `python3 scripts/descend_step_log.py start --run-id $RUN_ID --slice $SLICE --lane main --step RESOLVE_SLICE --epoch 1` then `python3 scripts/cloudbench_catalog.py resolve agents/benchmarks/tasks.json <slice>` (gap: `scripts/descend init`) |
| 2 | `SYNC_CHECKPOINT` | Commit pending timing rows alone, save state, sync main | `/sync` (gap: `scripts/descend sync`) |
| 3 | `PLAN_BATCH` | Pick the next batch from **Batch schedule** | gap: `scripts/descend plan` |
| 4 | `RUN_BATCH` | Launch it once in the background through its run sub-agent | `scripts/run-bench <tasks...> -k K --concurrency N` |
| 5 | `OBSERVE` | Watch it; diagnose errors with sub-agents as they arrive; publish the card at start, every 15 minutes, when nothing is left queued and at end | `scripts/run-bench monitor <run-dir>`; `scripts/run-bench scorecard <run-dir> --html <run-dir>/scorecard.html` |
| 6 | `INFRA_REPAIR` | On a 5% stop: fix the infra blockers now (ship with `/push` if production needs it), then rerun the same batch | see **Stopping conditions** |
| 7 | `RCA_FAILURES` | Start one `/RCA` per failed task as it fails; RCAs dedupe themselves | gap: `scripts/descend handoff <task>` |
| 8 | `ITERATION_RETRO` | Name the slowest step and apply one speedup, or record why none exists | `python3 scripts/descend_step_log.py report --slice $SLICE --task-count $N --lane main --window 5` |
| 9 | `NEXT_BATCH_OR_ROTATION` | Only when every RCA's fix is applied or its 100-minute box has expired, go back to 3; an RCA that returned without a fix is resumed, never counted as done | — |
| 10 | `RERUN_FULL_SLICE` | Once the batches have covered every task and pass at 95% or more, run the whole slice as one launch; below 95% returns to 7 | `scripts/run-bench <all tasks...> -k K --concurrency N` |
| 11 | `FINAL_CHANGE_REVIEW` | Start `/deploy`; its approval step reviews the guarded changes | `/deploy` |
| 12 | `DONE` / `BLOCKED` | Transition, then close the clock with verified counts | `python3 scripts/descend_step_log.py transition --step DONE ...` then `finish --status completed --run-terminal --detail scheduled_total=N --detail infra_failed=N` |

Time every state with `python3 scripts/descend_step_log.py transition --run-id $RUN_ID --lane main --step <STATE> --epoch $EPOCH`; `RUN_ID` is the run directory name and `EPOCH` counts full passes through 3–9.

## Guidelines

### Scope and conduct
- Invocation authorizes the requested slice, its fixes and infra repairs, not a different paid workload; an explicit user hold or go-gate overrides automatic batch advance.
- Persist the user's task names, goal, substrate, budgets, concurrency and acceptance rule in state; never import another run's profile.
- A user-directed behavior is already approved: implement, test and integrate it without a new approval packet.
- A progress card never ends authorized work; never enable a cron or grow paid workload beyond **Batch schedule** without a user request.
- Close observation gaps instead of making hasty assumptions; an unreproduced cause stays open and the next experiment changes to tell it apart.
- Report BLOCKED only after every safe in-scope alternative is exhausted; an external blocker never pauses unaffected work.

### Running benchmarks
- Run every batch and rerun on the cloud fleet from the worktree holding the fixes; use `--local` only when the user asks.
- Never split a batch across launches and never launch proof reruns; the next batch run is the outcome proof, and the only extra run is an RCA's granted single-task check under **Fixes**.
- The run sub-agent works in the background so the parent stays free; it reads new failures from every sample (`summary.json` and the job logs) and the parent starts their RCAs at once, and every card is the CLI-rendered one published per `/benchmark` **Reporting**, never a hand-made table.
- A sharded (>32-copy) run needs a clean pushed commit, its executed SHA must be verified, and fixes never move its launch ref while it runs.
- Never build or activate images in an ordinary descent; cold-image and mass-demo runs happen only when explicitly requested.
- Capacity and admission follow `/benchmark`'s capacity checks, and speedups respect provider rate limits: `scripts/cloudbench-provider-limits.json` (`python3 scripts/cloudbench-provider-capacity.py cap`) and Fly's `machines_per_org_limit`.
- When superseding a live run (a verified build with fixes it lacks is ready), copy its evidence, TERM its exact owner, and wait for its resources to be released before relaunching.
- At 5 minutes with no started task, inspect producer logs and the guest stage; a repeating wait line is not progress, and capture failure evidence before CLI cleanup.

### Integrity
- Never weaken a repro, relabel a runtime or product defect as INFRA, or let a publication or cleanup failure rewrite a genuine PASS/FAIL.
- A task definition (prompt, evaluator, expected tools, fixtures, criteria, timeout, load, concurrency, price cap) changes only when a fresh read-only cross-reviewer, independent of the RCA and fix authors, quotes the defect and proves from trajectories that the definition caused a valid failure or admits mutually exclusive correct outcomes; the edit restores the original intent and never loosens criteria, raises a timeout or renames a task.
- A third-party service that is plainly dead (out of credits, a proven outage) auto-quarantines its tasks, which are reported at **Final change review**.
- A missing compute token is not a skip: `Rose.complete` falls back to another credit line (Azure and others), so a failure there is a bug to fix.

## Batch schedule

- Batch size counts distinct tasks in one CLI launch; `-k` sets how many copies of each run (20 tasks at `-k 3` schedule 60 copies).
- Start at 20 tasks; after a batch with at least a 70% pass rate grow by 10 (at most 70), and after one below 70% shrink by 10 (at least 20).
- Order unvisited tasks by shortest effective timeout first (catalog timeout, recorded runtime, CLI default; step budget then name break ties) and keep similar timeouts together.
- An iteration is one batch run plus its fix round; keep a cohort for 5 iterations, appending the next shortest unvisited tasks when it grows, then switch to the next unvisited cohort; after the last cohort, loop back to the first.
- A batch stopped at 5% infra is rerun after its infra repair and never counts as an iteration, for the 5-iteration rotation or the success graph.
- Record iteration, cohort, task names, size, `-k`, concurrency, pass and infra numerator/denominator and the rotation cursor in state.

## Stopping conditions

- Stop the exact owned run when `scheduled_total > 0 && 20 * infra_failed_jobs >= scheduled_total` (30 of 600; exactly 5% stops), as every `/benchmark` launch does; count each scheduled job once, retries never change either count, unknown or cancelled jobs without infra evidence don't count, and an explicit user threshold overrides.
- Fix those infra blockers immediately (ship with `/push` if production needs them), then rerun the same batch until it completes under 5%; never relaunch it unchanged, and never auto-launch after NO TERMINAL ATTEMPTS.
- Preserve the first breach, original clocks and every physical attempt.
- The user says stop.

## RCA per failure

- INFRA means the environment failed before a trustworthy verdict; HARNESS means a trustworthy verdict failed real criteria, including a fallback that masks the required path; issue classes and the timeout and provider-limit evidence rules are in `/rca` **Classify**.
- As each task fails, start one muted `/RCA` thread for it via `boxes-delegated-threads`, with its own worktree and non-overlapping files, the task's run, attempt and agent IDs, FE link, evaluator output, source SHA, scope and a 100-minute time box (91% of 140 recorded RCA lanes finished within 100 minutes); fixing starts while the batch still runs; each handoff copies that job's agent ID, FE link and attempt number from its job log into the prompt (a pointer to the log is not enough), every failed task gets its RCA (never skip or defer one for budget), the time box is wall-clock time and never a tool-call or token cap, and when managed threads are unavailable the same handoff starts as a native background sub-agent.
- RCAs dedupe themselves: each first checks the RCA ledger in state and `python3 scripts/rca_archive.py search <terms>` for the same defect and, if another RCA already owns it, hands its task to that owner with its evidence (run, attempt and agent IDs, FE link, the matching boundary) and stops; before writing a fix it posts its named defect (code site and mechanism) to the ledger, and the later of two RCAs naming the same site hands over the same way.
- Never treat a shared symptom (failure string, evaluator, status, timeout, website or issue class) as the same defect.
- Before blaming the agent, confirm the judge saw what the user sees and no inherited repo-default gate applies; prove evaluator defects with judge-only replays and count the verdicts they change.
- Every RCA names a concrete defect at a code site (does X, should do Y, observed Z); a measurement is not a cause.

## Fixes

- At 90 minutes tell the owner: "10 minutes left: commit what works and hand back your evidence now, or it is lost." At 100 minutes take what it handed back.
- The next batch launches once every RCA's fix is applied or its time box expires; an expired RCA keeps its evidence, carries over, and never ships a guessed repair.
- An RCA that returns before its box expires without an applied fix is resumed with its evidence; a diagnosis is not a fix, the next batch still waits, and budget never justifies leaving it unresumed (report a binding budget cap as a blocker instead).
- Each RCA proves its fix at the owning boundary with an isolated local repro and lands that regression in the owning suite; it never uses a full end-to-end benchmark rerun as proof.
- When the fix needs an end-to-end check, the RCA asks the parent for a check slot; the parent grants it only when the task's recorded p90 plus 15 minutes of fleet startup ends before minute 85 and the provider and Fly budget hold the running batch plus every granted check.
- With a slot, the RCA runs only its own task once on the cloud fleet with `scripts/run-bench <task> --wait` in the background, never `--local`, with `CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES` set to the batch's simultaneous width plus the granted checks; the check publishes no card and is not outcome proof, and if it is still running at minute 95 the RCA TERMs its exact controller and confirms release before handing back.
- Never run `scripts/setup-db.sh` from a child worktree; give each its own identity, ports and Postgres so its `/sync` cannot reset the controller's or the shared `victoria` database.
- RCA workers never contact the user, change the active benchmark snapshot, launch batches or deploy; the parent applies each fix as its own row-tagged commit on the descent branch so it can be ablated.
- Any change may be applied; guarded hunks (prompts, agent behavior, trajectory injection, Zod schemas) and task-definition edits are approved in **Final change review** before deploying.
- Never `/deploy` to test a change; infra blockers that production needs ship with `/push`, everything else waits for the end.
- In the next batch run, a task that passes confirms its fix; a task that still fails gets a fresh RCA from its newest run, and a later first-bad boundary (the earliest point where the run goes wrong) is recorded as partial progress.

## Final change review

- Only guarded changes are reviewed: `/deploy`'s approval step covers the hunks its guards flag (a GROUNDED golden review clears them), and every task-definition edit goes to the user with its cross-review evidence.
- A rejected change is reverted, then its tasks and the full slice are rerun before the deploy freeze; repeat repair if the slice drops below 95%.
- Quarantined tasks are listed in the same packet with their provider evidence.

## State and timing

- Keep `.context/descend/<run-id>/state.json` current at every transition: original slice, task list, count and goal; current state, epoch and iteration; run start, finish and duration; latest subset; each task's latest accepted status; frozen scheduled total, terminal attempts and infra counts; every error occurrence with attempt IDs; the RCA ledger (task, owner thread, named defect, state, handed-to); quarantines; controller PIDs, artifacts and FE links.
- State also holds the change ledger: row tag to commit SHA, which hunks are guarded, golden-reference verdict and reviewer, and task-edit cross-review evidence.
- After compaction reload state, never rebuild it from memory, and resume the active clock in `.context/descend/<run-id>/timing/` or close it `--status interrupted`.
- Timing rows append to tracked `agents/benchmarks/history/descend_steps.jsonl`; never rewrite them or reset a slow clock, give each RCA lane its own `--lane rca-<ID>` pair, use `failed`, `blocked` or `interrupted` honestly, and pass only verified counts with `--detail`.
- Commit new timing rows alone before every `/sync` and before the final response.
- `/sync` before the first batch, before each fix worktree and before every batch; before syncing a dirty controller save state and keep in-progress work recoverable; wait for the DB resync and owning gates, record SHAs and conflicts in state, and let a failed sync block only its own action.
- Export `FACTORY_METADATA_FILE` per `docs/factory-telemetry.md` before the first timed step, snapshot it when configuration changes, publish the ledger at the end, and report model, effort, tier and collection gaps in the final card.

## Response contract

- Render every card with `scripts/run-bench scorecard <run-dir> --html <file>` per `scripts/run-bench report-format` and publish it; the card shows the latest real batch or slice run, never a proof or recovery run.
- Show `Overall slice: <passed>/<original total>` and `Latest run: <passed>/<batch total>` with producer-artifact times; never put a batch denominator in the Overall slice field.
- List each open RCA in ISSUES / NEXT ACTION with its tasks, named defect, owner and fix state.
- Show the wall-clock trend, the largest step regression and improvement, and the retro's chosen speedup.
- Pass the completed iteration count so the card's success-rate graph appears after iteration 3 (gap: `--iterations` exists only on the unmerged `descend/polar-*` branches).

## References

`.claude/commands/benchmark.md`, `.claude/commands/rca.md`, `.claude/commands/deploy.md`, `.claude/shared/approval-format.md`, `.claude/shared/benchmark-report-format.txt`, `agents/benchmarks/README.md`, `docs/factory-telemetry.md`; the previous version is in Git history (`git log -p -- .claude/commands/descend.md`).
