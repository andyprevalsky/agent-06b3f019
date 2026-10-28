# Shared skill display format

Apply this format to this agent and all current and future agents, including
every user-facing scorecard, progress report, status panel and approval card. Keep
each workflow's required evidence, fields and approval boundaries.

## Display clocks

- Display human-facing timestamps in **America/Los_Angeles**, respecting daylight
  saving time, using a 12-hour clock
  and `AM`/`PM`, for example `October 15, 11:45:00 AM PDT`. Include the date
  when needed to distinguish days. Use PDT (UTC−07:00) during daylight saving
  time and PST (UTC−08:00) in winter; never use a fixed PST offset year-round.
  Never use military time in display labels.
- Convert from the recorded instant; do not reset clocks or reinterpret an
  unzoned timestamp. Keep elapsed durations such as `14m18s` unchanged.
- Preserve machine timestamps and exact quoted evidence: UTC/ISO timestamps
  in stored telemetry, JSON, raw logs, commands, task prompts and diffs remain
  byte-for-byte intact. This rule changes presentation, not those artifacts.

## Sub-agent usage and work

Show every active worker and parent on one compact row with one status emoji,
**tokens spent on the current assignment**, rolling **15-minute tokens/min**,
and LIFE at the far right. This replaces percentage and pp/min columns.

```text
 AGENT / WORK                    TOKENS    15m tok/min     LIFE
 <status> <name>/<work>          <tokens>  <tokens/min>    <life>
```

Use `⛔` for a blocking dependency, `🔄` for active independent work, `🚀` for
deployment, `✅` for completed work and `🚨` for a verified advancing stall.
Keep actual milestones, gate results and batch item counts as separate facts.
Tokens measure usage; they do not certify completion, success or billing cost.

Use timestamped harness counters for recorded input + output, including cached
input. Reasoning output is already a subtype of output and must not be added
again. Retain source/session identity, capture time and the counter baseline at
or immediately before the assignment start. A request crossing that boundary
uses its recorded accounting timestamp; preserve the baseline method. Never
estimate tokens from text length, elapsed time or milestone percentages.
Show `UNMETERED` for an unavailable counter or scope baseline, never an invented
zero. Keep original scope and lifetime across retries. Freeze completed usage
at its actual completion receipt; later assignments get their own baseline.

### Lifetime: always the far-right column

- End every agent row with a fixed, right-aligned `LIFE` column. Put no status,
  task description, SHA or rate after it. Remove the visible `UPD` column.
- `LIFE` is time since the original recorded agent/thread start. Retain that
  instant across retries, task stages and restarts. If only an earlier assignment
  or observation is known, show a lower bound (`≥1h12m`) and retain its basis in
  telemetry. Freeze a completed agent's lifetime at its actual end.
- Keep actual evidence timestamps and freshness checks internally; removing a
  column does not make message receipt or rendering a new evidence observation.
  Use one capture instant for every row. Read active owners' existing reports or
  monitors; reuse immutable completion receipts. Do not add provider probes or
  wake idle agents solely to freshen a label. Mark overdue evidence `STALE` with
  its actual age without delaying safety notifications.
- Never present a saved or hand-kept summary as current. Every status line,
  parent/worker row and issue is rebuilt from current evidence at render time
  and carries the instant it was checked. A claim made before the latest run
  ended, or more than 15 minutes ago, is re-observed or left out; the scorecard
  renderer refuses such overlay rows.

### Rolling token usage and stalled work

- Persist timestamped usage observations with agent/session ID, scope ID,
  original start, baseline counters, current counters, state and source ref.
  Retain at least 15 minutes and preserve earlier assignment histories.
- `15m tokens/min = (current scoped tokens - scoped tokens 15 minutes ago) / 15`.
  Use actual same-scope counter observations with documented sample-and-hold.
  Do not divide a shorter window by 15, infer missing tokens, mix scopes or
  treat a counter reset as zero usage. Show `warming <age>` until a complete
  comparable window exists; show `UNMETERED` for missing continuity.
- Format large totals and rates compactly (for example `2.31M`, `154K/min`),
  retaining exact counters and input/cache/output breakdown in telemetry or
  expandable details. A completed row may show `complete` for its rate.
- Keep actual text colors for work status. High token use is not a verified
  success, and low or zero use alone is not a stall. A verified lack of outcome
  or milestone gain may still need `🚨` and a concrete corrective action.
  Healthy monitoring, completed, queued and expected waits get no false alarm.
- Beneath every red row, state the real blocker and corrective owner/action.
  Preserve qualified-task counts separately from token usage. Exact prompt,
  diff and approval payloads retain their required format and bytes.

## Conditional placement

- If **any sub-agent blocks** the report's next action, move the **whole ACTIVE
  SUB-AGENTS section** above the experiment history (LAST 10 for descent; LAST 3 otherwise). Do this if and only if a
  sub-agent is blocking; show the section once, never duplicate it.
- With no blocking sub-agent, place it after the experiment history. Show `No active agents`
  when the scorecard requires the section and no sub-agents are active.
- For other scorecards, use the same rule relative to their first progress
  section or gate list. For an approval card with no progress section, blocking
  sub-agent rows belong in the framed header; independent rows belong near the
  end. Preserve the six required approval sections and their order.

Report real blockers. An independent RCA, deploy, pending approval or incomplete
metric does not become a scheduling gate merely to move its section upward.

## Complete fields and result categories

- Do not display `null`, `—`, `N/A`, blank numeric fields or empty sentinels.
  Fetch available evidence through existing owners/monitors; when a metric
  cannot safely be measured, use a concrete state (`warming <age>`,
  `UNMETERED`, `UNMEASURED`, `NOT SCORED`) or omit its numeric row and state
  the coverage gap. A missing measurement never becomes an invented zero.
- Do not print explanatory LIFE/rate/color/monitoring legend paragraphs
  below agent rows. Keep the aligned headers and meaningful row states.
- Within each benchmark experiment, show `PASS`, `HARNESS FAILURE` and
  `INFRA FAILURE` counts, with genuine `AGENT FAILURE` preserved separately. Do not add a scheduled `PENDING` result row. Queued,
  running and terminal counts belong to that experiment's subrows. Genuine task
  failure and confirmed infrastructure failure keep
  their original classifications and denominators. Describe unscored
  cancellations/skips or unknown classifications in one coverage note;
  never convert them into agent/infra failures to fill the three rows.

Before dispatch, record the assignment and its actual token-counter baseline.
For running agents, recover that baseline from timestamped harness usage when
available; otherwise show UNMETERED. Starting a substep never resets LIFE.
Recompute usage rates from the same-scope history on every render. Warming
ends after 15 minutes of comparable history; never reuse cached rates.
After publishing, atomically update the existing latest-card URL and fixed
checkpoint fields together; do not create competing URL aliases.

## Standard CLI benchmark scorecard

This is the default for every future CLI benchmark run (cloud, local, eval,
campaign and production-only), its progress updates and final report.
Render it only with `scripts/run-bench scorecard <run-dir> --html <file>` and
publish that file unchanged; the CLI applies every rule in this section from
recorded artifacts. Hand-written or edited benchmark cards are non-compliant.

- Lead with **QUEUED**, **IN_PROGRESS** and **COMPLETED** logical task counts.
  Keep `QUEUED + IN_PROGRESS + COMPLETED = scheduled total`. COMPLETED means a
  recorded terminal outcome, not a pass; retries remain IN_PROGRESS until final.
- Directly below, always show **PASS**, **HARNESS FAILURE** and **INFRA FAILURE**.
  HARNESS FAILURE requires evidence of an orchestration/runner failure; never
  relabel a genuine task/agent failure as a harness failure. Preserve genuine
  **AGENT FAILURE**, cancelled, skipped, unscored and unknown outcomes separately.
  Do not infer zero from missing classification or add overlapping categories.
- A prepared run is explicitly **NOT LAUNCHED**. Planned queued tasks may be
  shown only with `planned`; they are not dispatched work or an actual experiment.
- Put the infra stop rule in a small note, using the original scheduled total
  (for example `Stop at 30/600 unique infra-failed jobs`). It is not a headline
  metric. Machine admission and qualification counts belong in supporting details.
- Retain the inline CSS-colored card, last-run age, latest three generic experiments (ten for descent),
  original clocks, current-assignment tokens, rolling 15-minute tokens/min,
  rightmost LIFE, lifecycle/resource evidence and explicit coverage gaps.
- Publish a fresh card when an agent starts or completes, every fixed 15-minute
  checkpoint, and whenever benchmark state changes. Events never postpone the
  existing checkpoint. Keep underlying 30-second operational monitoring active.

## Benchmark experiment history

For `/descend` cards (`--iterations N`, including zero), the following overrides
the generic three-row and launch-rate presentation: show up to the last **10**
actual selected experiments, newest first. Put **Iterations/Hour** prominently
at the top, using 3600 / the latest consecutive completed finish interval.
A currently running #8 uses #6 → #7; after #8 ends use #7 → #8. Include all work
between finishes. Missing, invalid, reversed or nonpositive endpoints are
UNMEASURED; do not bridge an intervening missing finish. Every finished row has
**T-<age> since finish**, calculated from NOW and its immutable producer finish.
Running rows use **T-RUNNING**; missing or future finish clocks use
**T-UNRECORDED**. Live client updates may change age text only, never the finish.
Generic experiments/day may remain secondary. Explicit history IDs, original
sources, verdicts, costs and lifecycle remain unchanged; do not pad to ten.
The existing >3 iteration success-graph threshold is unchanged.

- At the top, show **Since last benchmark ended** with the run label and elapsed
  time from its actual producer terminal timestamp. Keep this clock across
  diagnostics, cleanup and card refreshes. For a live benchmark show RUNNING;
  a missing end reads END UNRECORDED, never a guessed duration.
- First row: current **Experiment #<number>** and state. Beneath it show the
  average experiments/day for this goal: distinct actually launched original
  experiments divided by elapsed goal days. Preserve the original goal start;
  exclude diagnostics, prepared drafts and local tests. A sequence label is not
  a launch count. If receipts cover only part of history, label the numeric rate
  as a lower bound and state the verified launch count and elapsed days.
- Replace LAST SLICE TRIGGERED, WHY NO NEW SLICE, BENCHMARK PROGRESS, ACTIVE RUN
  and the standalone cost/cache/LLM section with **LAST 3 EXPERIMENTS**
  (**LAST 10 EXPERIMENTS** for descent), newest
  first. Each main row gives experiment, state, trigger, end and elapsed; use
  aligned concise subrows for QUEUED/IN_PROGRESS/COMPLETED counts, PASS/HARNESS FAILURE/
  INFRA FAILURE, genuine agent failures, unknown outcomes, cost, cache and LLM metrics, and lifecycle.
- Ends come from the actual producer terminal artifact; do not substitute an
  observer capture or export completion. Live rows use `RUNNING` and elapsed
  since their original trigger. Missing historical end evidence reads
  `END UNRECORDED`, with duration `UNMEASURED`; do not invent a timestamp.
- Metrics stay scoped to each experiment and all its attempts. Show actual
  cost/cache/latency coverage; use `UNMETERED` or `UNMEASURED` when absent,
  never invented zeroes. Keep cache categories and LLM populations separate
  when measured. Show unscored cancellations and unknown infra explicitly.
- For a blocking provider/resource limit, name the exact limit, observed usage,
  numeric cap when actually known, and the concrete action the owner or user can
  take. Distinguish app usage from organization-wide quota. Do not recommend a
  quota increase before reconciling owned idle resources and supported reuse.
- Put the stop threshold in a small supporting note using the original scheduled denominator: for 600
  jobs, `STOP AT 30/600 INFRA (5%)`. Explain an earlier wrong 1/1 stop as an
  erroneous early abort, not as a valid threshold breach or a retroactive pass.
- Preserve a concise ISSUES / NEXT ACTION section. Put the actual reason and
  corrective owner/action immediately beneath every red progress row. Do not
  reintroduce removed global sections or append explanatory legends.

## Resource costs and current work

- Show timestamped started/stopped counts and separately verified idle/warm
  counts. Preserve designated warm Machines. Charge idle started VMs at the
  running rate; distinguish stopped rootfs and allocated-volume storage.
  Identify estimate coverage, rates and unknown billed usage; never invent an
  invoice total or treat provisioned maximum rootfs as billed usage.
- Close each run's idle compute through the normal exact-owner stop guards;
  retained evidence or warm storage does not require a controller to keep running.
  Report confirmed STOPPED separately from requests and pending transitions.
- Explain why capacity is needed from measured workload/reuse evidence. A
  symbolic planner maximum does not justify a quota increase. Give a concrete
  unblock action in the report.
- Bind worker token totals/rates to the current assignment. Retain prior scopes
  separately; do not charge old RCA usage to unrelated work, reset history to
  hide usage, or manufacture milestones from tokens spent.

## Card colors

- Color-code the actual text, not just emoji or diff prefixes. On boxes.dev,
  use the `boxes-inline-visualizations` skill to publish a self-contained HTML
  scorecard with CSS text colors: green verified successes/healthy checks,
  red failures/blockers, blue active work/headings and amber warnings/unmeasured
  coverage. Preview light, dark and 360px layouts, then publish the standalone
  visual link. This overrides the diff-fence presentation for progress cards;
  it does not change exact approval packets or evidence payloads.
- Diff highlighting is only a fallback when rendered HTML is unavailable;
  explain that limitation instead of claiming emoji or prefixes colored text.
  Keep status markers for accessibility. Do not color an unknown result as
  a pass or failure, and do not rely on color alone.
- Retain the signed rate colors and one status emoji per agent. Active work
  is not a verified outcome. Color changes must not alter classifications,
  measurements, original clocks or the existing sections.
- Show the latest three generic original experiments or ten for descent; retain
  complete history internally and use all verified launches for secondary experiments/day.


### Descent speed change (user clarification)

The compact descent headline is `<rate> iter/h [avg Δ <signed percent> over last 5 runs]`.
Avg Δ uses five consecutive finished recorded experiments (four finish-to-finish
speeds), then takes the arithmetic mean of the three successive changes:
100 * (next_speed / previous_speed - 1). It is neither mean speed nor endpoint
change. Retain failed/cancelled finishes and all inter-experiment work. Skip only
the latest current running experiment; never bridge missing/invalid finishes.
Fewer than five consecutive valid finishes show UNMEASURED with n/5 coverage.
Positive change is green with +, negative red with -, and stationary is 0.0%.
Keep the full Iterations/Hour and finish-to-finish definition in a secondary
line/title; the last ten rows and T- clocks are unchanged.
