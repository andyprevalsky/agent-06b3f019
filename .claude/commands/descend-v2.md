---
description: "Run a benchmark slice on the cloud fleet in batches, cluster every error by root cause, fix each cluster with /RCA, iterate until the slice is green, then /deploy with one final change review."
argument-hint: "<slice> — first N polar tasks | daily | pre-deploy | rose-bench | polar-bench | incomplete | explicit task names"
---

# /descend

The one benchmark and experiment iteration loop. Read `/benchmark`, `/rca` and `/deploy` first, including before every launch a delegated owner makes; this command owns only their orchestration, state and response.

## Done

Every original task passes every `-k` copy in one full-slice run; then start `/deploy`, whose approval step is the only review (**Final change review**). Infra-only or consecutive-slice goals use the user's own acceptance rule; never add another gate. Start the descent with `/goal` on the slice being all green.

## Process

| # | State | Step | Command |
|---|-------|------|---------|
| 1 | `RESOLVE_SLICE` | Start the clock, then resolve the slice and freeze its names, count and goal in state | `python3 scripts/descend_step_log.py start --run-id $RUN_ID --slice $SLICE --lane main --step RESOLVE_SLICE --epoch 1` then `python3 scripts/cloudbench_catalog.py resolve agents/benchmarks/tasks.json <slice>` (gap: `scripts/descend init`) |
| 2 | `SYNC_CHECKPOINT` | Commit pending timing rows alone, save state, sync main | `/sync` (gap: `scripts/descend sync`) |
| 3 | `PLAN_BATCH` | Pick the next batch from **Batch schedule** | gap: `scripts/descend plan` |
| 4 | `RUN_BATCH` | Launch it once in the background through its run sub-agent | `scripts/run-bench <tasks...> -k K --concurrency N` |
| 5 | `OBSERVE` | Watch it; diagnose errors with sub-agents as they arrive; publish the card at start, every 15 minutes, when nothing is left queued and at end | `scripts/run-bench monitor <run-dir>`; `scripts/run-bench scorecard <run-dir> --html <run-dir>/scorecard.html` |
| 6 | `INFRA_REPAIR` | On a 5% stop: fix the infra blockers now (ship with `/push` if production needs it), then rerun the same batch | see **Stopping conditions** |
| 7 | `TRIAGE_FAILURES` | One read-only triage card per failed task | gap: `scripts/descend triage` |
| 8 | `CLUSTER_FAILURES` | Cluster, rank and hand each cluster to its own fix sub-agent | gap: `scripts/descend handoff <cluster>` |
| 9 | `ITERATION_RETRO` | Name the slowest step and apply one speedup, or record why none exists | `python3 scripts/descend_step_log.py report --slice $SLICE --task-count $N --lane main --window 5` |
| 10 | `NEXT_BATCH_OR_ROTATION` | When fixes are applied or time-boxed, go back to 3 | — |
| 11 | `RERUN_FULL_SLICE` | Once every task passed in its batches, run the whole slice as one launch; any failure returns to 7 | `scripts/run-bench <all tasks...> -k K --concurrency N` |
| 12 | `FINAL_CHANGE_REVIEW` | Start `/deploy`; its approval step reviews the guarded changes | `/deploy` |
| 13 | `DONE` / `BLOCKED` | Transition, then close the clock with verified counts | `python3 scripts/descend_step_log.py transition --step DONE ...` then `finish --status completed --run-terminal --detail scheduled_total=N --detail infra_failed=N` |

Time every state with `python3 scripts/descend_step_log.py transition --run-id $RUN_ID --lane main --step <STATE> --epoch $EPOCH`; `RUN_ID` is the run directory name and `EPOCH` counts full passes through 3–10.

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
- Never split a batch across launches and never launch proof reruns; the next batch run is the outcome proof.
- A sharded (>32-copy) run needs a clean pushed commit, its executed SHA must be verified, and fixes never move its launch ref while it runs.
- Never build or activate images in an ordinary descent; cold-image and mass-demo runs happen only when explicitly requested.
- Capacity and admission follow `/benchmark`'s capacity checks, and speedups respect provider rate limits: `scripts/cloudbench-provider-limits.json` (`python3 scripts/cloudbench-provider-capacity.py cap`) and Fly's `machines_per_org_limit`.
- When superseding a live run (a verified build with fixes it lacks is ready), copy its evidence, TERM its exact owner, and wait for its resources to be released before relaunching.
- At 5 minutes with no started task, inspect producer logs and the guest stage; a repeating wait line is not progress, and capture failure evidence before CLI cleanup.

### Integrity
- Never weaken a repro, relabel a runtime or product defect as INFRA, or let a publication or cleanup failure rewrite a genuine PASS/FAIL.
- A task definition (prompt, evaluator, expected tools, fixtures, criteria, timeout, load, concurrency, price cap) changes only when a fresh read-only cross-reviewer, independent of the triage and fix authors, quotes the defect and proves from trajectories that the definition caused a valid failure or admits mutually exclusive correct outcomes; the edit restores the original intent and never loosens criteria, raises a timeout or renames a task.
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

## Triage and clustering

- INFRA means the environment failed before a trustworthy verdict; HARNESS means a trustworthy verdict failed real criteria, including a fallback that masks the required path; issue classes, the `/rca` bucket map and complexity tiers are in `docs/root-cause-analysis.md`.
- Triage only failed tasks: each gets a read-only card at `.context/descend/<run>/triage/<epoch>/<task>.json` with agent IDs, FE link, run and attempt IDs, verbatim failed evaluator, terminal status and last tool, boundary evidence (line, span or row), archive hits, prior outcomes and a contrast with a passing run.
- Triage workers run only `/rca` Steps 0–0.5 (including `python3 scripts/rca_archive.py search <terms>`) and write no repro, fix or code.
- The first-bad boundary is the earliest point where a run diverges from correct behavior; `observed` means the task's own evidence shows it, otherwise the card is `inferred`.
- A cluster is the failed tasks whose own evidence shows the same first-bad boundary, so that one fix there is expected to flip all of them; a two-cause task joins both clusters.
- Every inferred card is a singleton, and an unknown cause is an observability-gap singleton.
- Never cluster on a shared symptom (failure string, evaluator, status, timeout, website or issue class).
- Cluster each card as it arrives: it joins an open cluster whose observed boundary it shares (that cluster's fix owner gets the new member) or opens a new cluster whose fix owner starts at once, so fixing begins while the batch still runs.
- Run a choke-point pass over every FAIL and PASS run: a mechanism common in failures and rare in passes is a cluster hypothesis; prevalence only ranks hypotheses, and each run's own observed mechanism grants membership.
- Before blaming the agent, confirm the judge saw what the user sees and no inherited repo-default gate applies; prove evaluator clusters with judge-only replays and count the verdicts they change.
- Every cluster names a concrete defect at a code site (does X, should do Y, observed Z); a measurement is not a cause, and timeout and provider-limit evidence follows `docs/root-cause-analysis.md`.
- Give each cluster a stable ID, a kebab-case boundary name, its members and one exemplar (observed evidence, cheapest owning repro); on a new epoch add occurrences to existing clusters first.
- Rank clusters by user priority, then member-task count (largest first), then complexity tier, then row ID; re-rank only when membership or priority changes.

## Fixes

- Dispatch one muted fix thread per cluster via `boxes-delegated-threads`, each with its own worktree and non-overlapping files, carrying the cluster row, cards, exemplar logs, source SHA, scope, priorities and a 60-minute time box (84% of 140 recorded RCA lanes finished within 60 minutes).
- An RCA owner first checks the live cluster ledger and `rca_archive.py search` for the same boundary and reports a duplicate instead of starting; when two RCAs prove the same boundary, the parent merges their clusters.
- At 50 minutes tell the owner: "10 minutes left: commit what works and hand back your evidence now, or it is lost." At 60 minutes take what it handed back.
- The next batch launches once every dispatched fix is applied or its time box expires; an expired cluster keeps its evidence and rank, carries over, and never ships a guessed repair.
- Each RCA proves its fix at the owning boundary with an isolated repro and lands that regression in the owning suite; it never uses a full end-to-end benchmark rerun as proof.
- Never run `scripts/setup-db.sh` from a child worktree; give each its own identity, ports and Postgres so its `/sync` cannot reset the controller's or the shared `victoria` database.
- Workers never contact the user, change the active benchmark snapshot, launch paid runs or deploy; the parent applies each fix as its own row-tagged commit on the descent branch so it can be ablated.
- Any change may be applied; guarded hunks (prompts, agent behavior, trajectory injection, Zod schemas) and task-definition edits are approved in **Final change review** before deploying.
- Never `/deploy` to test a change; infra blockers that production needs ship with `/push`, everything else waits for the end.
- In the next batch run, every member passing confirms the fix; a member that still fails is re-triaged in parallel from its newest run, where a later first-bad boundary means the fix helped and the task now joins whatever cluster matches; a failing exemplar returns the cluster to `/RCA` at its rank.

## Final change review

- Only guarded changes are reviewed: `/deploy`'s approval step covers the hunks its guards flag (a GROUNDED golden review clears them), and every task-definition edit goes to the user with its cross-review evidence.
- A rejected change is reverted, then its tasks and the full slice are rerun before the deploy freeze; repeat repair if green is lost.
- Quarantined tasks are listed in the same packet with their provider evidence.

## State and timing

- Keep `.context/descend/<run-id>/state.json` current at every transition: original slice, task list, count and goal; current state, epoch and iteration; run start, finish and duration; latest subset; each task's latest accepted status; frozen scheduled total, terminal attempts and infra counts; every error occurrence with attempt IDs; triage cards; cluster lifecycle, rank and members; quarantines; controller PIDs, artifacts and FE links.
- State also holds the change ledger: row tag to commit SHA, which hunks are guarded, golden-reference verdict and reviewer, and task-edit cross-review evidence.
- After compaction reload state, never rebuild it from memory, and resume the active clock in `.context/descend/<run-id>/timing/` or close it `--status interrupted`.
- Timing rows append to tracked `agents/benchmarks/history/descend_steps.jsonl`; never rewrite them or reset a slow clock, give each RCA lane its own `--lane rca-<ID>` pair, use `failed`, `blocked` or `interrupted` honestly, and pass only verified counts with `--detail`.
- Commit new timing rows alone before every `/sync` and before the final response.
- `/sync` before the first batch, before each fix worktree and before every batch; before syncing a dirty controller save state and keep in-progress work recoverable; wait for the DB resync and owning gates, record SHAs and conflicts in state, and let a failed sync block only its own action.
- Export `FACTORY_METADATA_FILE` per `docs/factory-telemetry.md` before the first timed step, snapshot it when configuration changes, publish the ledger at the end, and report model, effort, tier and collection gaps in the final card.

## Response contract

- Render every card with `scripts/run-bench scorecard <run-dir> --html <file>` per `scripts/run-bench report-format` and publish it; the card shows the latest real batch or slice run, never a proof or recovery run.
- Show `Overall slice: <passed>/<original total>` and `Latest run: <passed>/<batch total>` with producer-artifact times; never put a batch denominator in the Overall slice field.
- List each cluster in ISSUES / NEXT ACTION with ID, kind, issue class, members, boundary, owner and fix state.
- Show the wall-clock trend, the largest step regression and improvement, and the retro's chosen speedup.
- Pass the completed iteration count so the card's success-rate graph appears after iteration 3 (gap: `--iterations` exists only on the unmerged `descend/polar-*` branches).

## References

`.claude/commands/benchmark.md`, `.claude/commands/rca.md`, `.claude/commands/deploy.md`, `.claude/shared/approval-format.md`, `.claude/shared/benchmark-report-format.txt`, `docs/root-cause-analysis.md`, `agents/benchmarks/README.md`, `docs/factory-telemetry.md`; the previous version is `.claude/commands/descend.md`.
