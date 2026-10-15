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

## Sub-agent progress

Show every active sub-agent on one compact row with one status emoji and an
integer percentage from **0% to 100%**. Replace progress wheels with the status
emoji; do not add a second ring or spinner.

```text
 AGENT / WORK                    PCT    Δ15m/min          LIFE
 <status> <name>/<work>          <%>    <signed pp/min>   <life>
```

Use `⛔` for a blocking dependency, `🔄` for active independent work, `🚀` for
deployment, `✅` for completed work and `🚨` for a verified advancing stall.
A healthy monitoring row may use `MONITORING` as its stage instead of inventing
a completion percentage. Keep the layout consistent for the parent and workers.

Compute progress from completed, evidenced milestones in the agent's assigned
scope, rather than elapsed time, tokens spent or merely being alive. Round to
the nearest whole percentage, with halves rounded up. Use 100% only after all
required assignment milestones are verified; cap an incomplete assignment at
99% if rounding would otherwise reach 100%. Define the
milestones at dispatch and retain their denominator. For agents already running
when this format is adopted, record the milestone basis with their first
percentage update. Never silently reuse percentages from a previous scope.
Mark the percentage as
an estimate when the milestone weights are approximate. A completed local
candidate is not 100% of an assignment that still requires outcome proof or
cleanup. Read the latest worker report or status before publishing a card.
Retain the last known percentage when a newer update is unavailable, and retain
its actual evidence timestamp internally. If it is overdue, mark the state
`STALE <age>` in a concise action line. A missing
update is not zero progress and is not proof that the agent is stalled.

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

### Rolling progress and stalled work

- Persist timestamped progress observations with agent ID, scope ID, milestone
  basis, original start, observation time, percentage, state and evidence ref.
  Retain history for at least the full previous 15 minutes; a new scope starts
  a new comparable series while retaining the agent's lifetime.
- `Δ15m/min = (current percent − percent 15 minutes ago) / 15`, measured in
  **percentage points per minute**, not percent growth or elapsed-time progress.
  Use a same-scope observation at the cutoff, or documented sample-and-hold
  between verified milestones. Record the baseline timestamp/method. Never
  interpolate invented progress, compare different denominators, divide a
  shorter window by 15, or reuse a previous scope's percentage.
- Show a signed value to two decimal places, e.g. `+0.67pp/m` or `-0.20pp/m`.
  Positive is green; zero or negative is red. Use CSS text colors in the
  rendered HTML scorecard. For a plain fallback, use a single `diff` fence:
  prefix positive rate rows with `+`, and zero or
  negative rate rows with `-`, for syntax color. Emoji retain the sign's color
  when syntax highlighting is unavailable. With less than a full comparable
  window, write `warming <age>` and record its start; never fabricate a zero rate.
- Show `🚨` on an actively advancing assignment with a verified full 15-minute
  window and no milestone gain (`delta <= 0`); describe it as `no milestone gain
  15m` or `regressed`, not proof that the process is dead. Missing/stale evidence
  is an observability gap, not proof of a stall. Healthy `MONITORING`, completed,
  queued or explicitly expected waits do not get a false stall alarm; show that
  state and the next expected milestone/condition instead.
- Immediately beneath every red progress row, put one short line naming why
  there was no gain and the specific action/owner addressing it. For completed
  work or steady monitoring, state that condition and its remaining action
  without falsely calling it stalled. A repeated real stall requires a changed
  approach, not another identical explanation.
- Apply the same rate/freshness rules to the parent agent when included. Keep
  qualified-task progress separate from a terminal-outcome completion bar.
  Do not rewrite exact prompt/diff/approval payloads for color: approval blocks
  retain their required `text` fence and use the colored rate markers.

Use 0% only for an explicitly queued/not-started assignment or a verified zero
completed-milestone report. If no percentage is known, inspect the actual stage
and give an evidenced milestone estimate; if that is still unavailable, show
`MILESTONES UNDEFINED` and obtain a report instead of inventing 0%. Keep
start/block clocks and frozen checkpoints where applicable.

## Conditional placement

- If **any sub-agent blocks** the report's next action, move the **whole ACTIVE
  SUB-AGENTS section** above `LAST 3 EXPERIMENTS`. Do this if and only if a
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
- Within each benchmark experiment, show `PASS`, `AGENT FAILURE` and
  `INFRA FAILURE` counts. Do not add a scheduled `PENDING` result row. Queued,
  running and terminal counts belong to that experiment's subrows. Genuine task
  failure and confirmed infrastructure failure keep
  their original classifications and denominators. Describe unscored
  cancellations/skips or unknown classifications in one coverage note;
  never convert them into agent/infra failures to fill the three rows.

Before dispatch, the parent records numeric milestone weights for every agent.
For an already running agent, establish an evidenced estimate from completed
milestones before publishing its percentage; keep that same scope and weights
for subsequent rates. Starting a substep never resets the agent lifetime.
Recompute each render from timestamped same-scope history. Warming ends once
15 minutes of history exist; never leave a cached warming flag or rate frozen.
After publishing, atomically update the existing latest-card URL and fixed
checkpoint fields together; do not create competing URL aliases.

## Benchmark experiment history

- First row: current **Experiment #<number>** and state. Beneath it show the
  average experiments/day for this goal: distinct actually launched original
  experiments divided by elapsed goal days. Preserve the original goal start;
  exclude diagnostics, prepared drafts and local tests. A sequence label is not
  a launch count. If receipts cover only part of history, label the numeric rate
  as a lower bound and state the verified launch count and elapsed days.
- Replace LAST SLICE TRIGGERED, WHY NO NEW SLICE, BENCHMARK PROGRESS, ACTIVE RUN
  and the standalone cost/cache/LLM section with **LAST 3 EXPERIMENTS**, newest
  first. Each main row gives experiment, state, trigger, end and elapsed; use
  aligned concise subrows for queue/running/terminal counts, PASS/AGENT FAILURE/
  INFRA FAILURE, unknown outcomes, cost, cache and LLM metrics, and lifecycle.
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
- Label the stop threshold using the original scheduled denominator: for 600
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
- Bind worker percentages/rates to the current assignment. Retain blocked prior
  scopes separately; do not leave old RCA percentages on unrelated active work,
  reset history to hide a stall, or manufacture milestone gains.

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
- Show only the latest three original experiments; retain complete history
  internally and use all verified launches for experiments/day.
