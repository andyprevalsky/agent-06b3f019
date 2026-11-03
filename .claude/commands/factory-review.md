---
description: "Analyze /deploy, /RCA, and checked-in /descend factory telemetry as concise retry and timing tables."
argument-hint: "[--deploy-since YYYY-MM-DD] [--limit N] [--descend-window N]"
---

# Factory Review

Generate the factory workflow review from local Conductor history and the
checked-in `/descend` factory-event ledger:

```bash
git fetch -q origin main || true
python3 scripts/factory_review.py --self-test
python3 scripts/factory_review.py --open $ARGUMENTS
```

Without a Conductor database (boxes.dev and other Linux machines), `--source auto`
rebuilds /deploy and /RCA from the tracked
`agents/benchmarks/history/factory_events.jsonl`, in both the working tree and
`origin/main`, plus this machine's unpublished `.context` telemetry. Every
`/deploy`, completed or blocked, runs `python3 scripts/factory_ledger.py publish`.
That appends the machine's `/deploy`, `/RCA` and `/update-prompts` timestamps, and
any missing `/descend` rows, straight to `main`. Add archived telemetry with
`--telemetry-root DIR`, or publish it with `factory_ledger.py publish --source-root
DIR`.
boxes.dev thread reads carry no message timestamps, so they are not a timing
source. A run without stage records or a final outcome event stays out of the
tables; missing measurements render as `—`, never as zero. On boxes.dev, publish
the HTML with the `boxes-inline-visualizations` skill instead of `--open`.

Add a deploy-path benchmark trajectory section from the checked-in predeploy
ledger (`task_attempts.jsonl`, `suite: predeploy`): per trajectory, its share of
predeploy agent time, deploys, runs per deploy, median duration, cost per deploy,
pass rate and failed deploys. Group deploys by the branch-named span ledgers and
fall back to time gaps. List same-category trajectories as combination
candidates with the product of member pass rates, the expected pass rate of one
merged trajectory.

The "Failures, reruns and gaps" section (`scripts/factory_diagnostics.py`) reads
each stage/event `detail`: per-gate failure classes and first failing names,
rerun causes (new commit, worktree edit, unchanged rerun), exact-reuse hits and
miss reasons, setup/queue/exec medians with host load and memory, idle gaps
attributed to fixes, approval/review/external-deploy waits, RCA repro attempts
and per-run benchmark/`/descend` counts. Rows recorded before detail existed
count toward attempts and gaps only; its coverage line states how many rows
carry detail.

The report must keep each gate family separate and show exactly these columns:

Add a `/descend` section sourced from
`agents/benchmarks/history/descend_steps.jsonl`. It must use canonical
`stage-start`, `stage-finish`, and terminal `outcome` factory events, report
completed main-lane wall clock and per-state timing, and compare the latest
window with the immediately preceding window. Negative change means faster.

Put one short, plain-English description directly under every step title. State
what actually runs; for example, Auto-fix formats files and applies lint fixes.

- **Runs** — average distinct lifecycle execution bursts per command; overlapping
  sibling calls count as one run, and skipped gates count as zero. Combined
  coverage-blackbox lifecycles appear in both semantic rows but count once in
  the Total row.
- **Avg Time** — average lifecycle wall clock from that run's first command
  start until the next lifecycle starts or the final command finishes.
- **Approval guards** — measure from the assistant's explicit request for human
  approval until the human approves or rejects, including cross-turn waits. Do
  not time the approval-check shell command. Use every resolved observation
  from every deploy attempt, not only attempts that later completed; show the
  observation and attempt counts. Prefer structured `record_factory_event.py`
  boundaries and retain prose inference only for historical runs.
- **Total Time** — average union of that step's lifecycle wall-clock envelopes.
  For the Total row, use the logical deploy from the first blocked `/deploy`
  through the completed resumed `/deploy`; never add parallel branches or
  parallel commands within a lifecycle.
- **Parallel group wall clock** — immediately after Group 3 and Group 4, show a
  compact subtotal row with only the badge and Total Time; no visible title,
  description, Runs, or Avg Time. Compute the union of the member lifecycle
  envelopes, never their sum. It equals the longest member only when starts and
  retries align. Group subtotals do not necessarily add to end-to-end because
  groups may overlap and transitions, fixes, commits, or waits can sit outside
  classified gates.
- **Trend** — compact Runs/command, Avg Time/pass, and Total Time/command charts
  inside their matching metric cells.
- **Collection** — prefer `run-deploy-stage` gate timings plus explicit factory
  events for approval, runtime-blackbox, code-review, production, and RCA
  boundaries. Incomplete event pairs must be flagged rather than replaced with
  inferred data. Use generic tool/prose inference only for history that predates
  those hooks.
- **Combined gates** — backend, frontend, agents, and mac coverage commands run
  their blackbox suites once under instrumentation. Attribute each combined
  invocation to both Coverage and Runtime blackbox, but union the identical
  interval only once in Group 3 wall clock. Keep unrelated bundled historical
  shell calls unsplit.
- **Execution** — every row gets one compact badge. Number canonical rows by
  start order; matching numbers mean the rows start together. Use a yellow `3`
  for Static verify, Coverage, and Runtime blackbox (including changed mac-app
  blackbox), and an orange `4` for Code review, Smoke, AgentCard, and Semantic.
  Production verify is `5`. Spell out `Total` in its badge; never use cryptic
  symbols or abbreviations. Number `/RCA` rows `1`, `2`, `3`. Never show ranges
  such as `1–7` or `4→7`.
- **Historical unsplit logs** — when one old shell tool call contains multiple
  gates, it is not a deploy state and must not appear in the sequenced rows.
  Show one compact `Historical data gap — not a deploy step` note with its
  calls/deploy and wall clock. Exclude it from stage Runs, but keep it inside the
  real end-to-end command time. Never invent an internal split.

Put a Weekly / Monthly / Quarterly toggle above the tables. Its selected range
must update concise percentage deltas beside Runs and Avg Time, comparing the
latest period with the immediately prior period. Use all completed history for
trends, except Approval guards, which use every deploy attempt so blocked
decisions are not discarded. Label the exact calendar date range shown; never use vague "last N
periods" copy. Hover must snap to the nearest real point and show its exact
calendar interval, value, completed-command count, lifecycle count, and observed
wall-clock time. Show sparse data without inferring a direction. For both
workflows, identify complete instrumentation, historical inference, and partial
telemetry in the visible summary and trend metadata; never present inferred
history as instrumented. For `/RCA`, use explicit stage events when complete.
Never replace a real percentage with an `n<2` label; expose low sample counts in
the hover details instead.

Open the generated HTML, then report only the dominant `/deploy` bottlenecks and
the `/RCA` sample size. Do not replace the table with individual invocation
dumps.

Artifacts:

- `.context/factory-review/factory-review.html`
- `.context/factory-review/factory-review.json`

## Required factory execution metadata

Follow `docs/factory-telemetry.md` for every new factory run. Record exact
model/provider, effort, speed/service tier, harness/version, scoped token/cache
usage and cost, worker attribution, resource/concurrency context, disjoint wait
times and validation provenance. Every known value requires a timestamped source;
unavailable values stay explicitly unknown. Never guess historical settings or
publish raw transcripts, secrets or signed URLs. Set `FACTORY_METADATA_FILE`
before collection, append snapshots for changes and publish the ledger. Final
scorecards report model/effort/tier and collection gaps alongside timings.
