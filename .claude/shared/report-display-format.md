# Shared skill display format

Every agent's user-facing scorecard, progress report, status panel and approval card follows this file, keeping each workflow's required evidence, fields and approval boundaries. Benchmark cards: `.claude/shared/benchmark-report-format.txt` (`scripts/run-bench report-format`). Approval packets: `.claude/shared/approval-format.md`. Deploy failure ownership: `.claude/shared/deploy-failure-policy.md`.

Sections: Clocks · Agent rows · Placement · Freshness · Fields · Work versus waiting · Colors and publication · Resources and blockers · Deploy scorecard: deploy-summary-v2.

## Clocks

- Show human-facing times in America/Los_Angeles on a 12-hour clock with `AM`/`PM`, e.g. `October 15, 11:45:00 AM PDT`: PDT (UTC−07:00) in daylight saving time, PST (UTC−08:00) in winter, never a fixed year-round offset or military time.
- Add the date when it distinguishes days.
- Convert from the recorded instant; never reset a clock or reinterpret an unzoned timestamp, and keep elapsed durations such as `14m18s` as they are.
- This is presentation only: stored telemetry, JSON, raw logs, commands, task prompts, diffs and quoted evidence keep their UTC/ISO timestamps byte for byte.

## Agent rows

```text
 AGENT / WORK                    TOKENS    15m tok/min     LIFE
 <status> <name>/<work>          <tokens>  <tokens/min>    <life>
```

- One compact row per active worker and parent: one status emoji, tokens spent on the current assignment, rolling 15-minute tokens/min, then LIFE; these replace PCT/percentage, pp/min, UPD and progress-wheel columns.
- Status emoji: `⛔` blocking dependency, `🔄` active independent work, `🚀` deployment, `✅` completed, `🚨` verified advancing stall.
- LIFE is the fixed, right-aligned last column (no status, description, SHA or rate after it): time since the original recorded agent/thread start, kept across retries, stages, substeps and restarts, and frozen at the actual end.
- When only a later assignment or observation start is known, LIFE shows a lower bound (`≥1h12m`) and telemetry keeps its basis.
- Tokens are timestamped harness counters of recorded input + output including cached input; reasoning output is already part of output and is never added again; never estimate tokens from text length, elapsed time or milestone percentages.
- Record the assignment and its counter baseline (source/session identity, capture time) at or just before dispatch; for an already-running agent recover it from timestamped harness usage; a request crossing that boundary uses its recorded accounting timestamp under the same baseline method.
- Keep the original scope and lifetime across retries, freeze usage at the actual completion receipt, and give each later assignment its own baseline; keep prior scopes separate, never charge old RCA usage to unrelated work, and never reset history to hide usage.
- `15m tokens/min = (current scoped tokens - scoped tokens 15 minutes ago) / 15`, recomputed every render (never cached) from persisted same-scope observations with documented sample-and-hold: agent/session ID, scope ID, original start, baseline and current counters, state and source ref, retained at least 15 minutes with earlier assignment histories.
- Show `warming <age>` until 15 minutes of comparable history exist, and `UNMETERED` for a missing counter, scope baseline or continuity, never an invented zero; never divide a shorter window by 15, infer missing tokens, mix scopes or treat a counter reset as zero usage.
- Format totals and rates compactly (`2.31M`, `154K/min`), keeping exact counters and the input/cache/output breakdown in telemetry or expandable details; a completed row may show `complete` as its rate.
- Tokens measure usage, never completion, success or billed cost; keep milestones, gate results, batch item and qualified-task counts as separate facts, and never manufacture milestones from tokens.
- High usage is not success and low or zero usage alone is not a stall; a verified lack of outcome or milestone gain may get `🚨` and a concrete corrective action, while healthy monitoring, completed, queued and expected waits get no false alarm.

## Placement

- If any sub-agent blocks the report's next action, the whole ACTIVE SUB-AGENTS section goes above `LAST 3 EXPERIMENTS` (on other cards, above the first progress section or gate list); otherwise it goes after that history; it appears once, reading `No active agents` when required and empty.
- Only real blockers move it: an independent RCA, deploy, pending approval or incomplete metric never becomes a scheduling gate.
- An approval card without a progress section puts blocking rows in its framed header and independent rows near the end, keeping approval-format.md's seven required sections in order.

## Freshness

- Never present a saved or hand-kept summary as current: rebuild every status line, parent/worker row and issue from current evidence at render time, stamped with the instant it was checked.
- Re-observe or omit any claim made before the latest run ended or more than 15 minutes ago; the scorecard renderer refuses such overlay rows.
- Use one capture instant for every row; read active owners' existing reports and monitors and reuse immutable completion receipts, never probing providers or waking idle agents just to freshen a label.
- Keep evidence timestamps and freshness checks internal; receiving a message or rendering is not a new observation; mark overdue evidence `STALE` with its actual age, never delaying safety notifications.
- After publishing, atomically update the existing latest-card URL and fixed checkpoint fields together, never creating competing URL aliases.
- Refresh lifecycle labels from verified receipts (a completed export never stays pending); long batches keep fixed-cohort receipt counts and original clocks, and a new rendering or reread of old evidence never creates a usage or outcome delta.

## Fields

- Never display `null`, `—`, `N/A`, blank numeric fields or empty sentinels: fetch evidence through existing owners and monitors, otherwise show a concrete state (`warming <age>`, `UNMETERED`, `UNMEASURED`, `NOT SCORED`) or omit the numeric row and state the coverage gap; a missing measurement never becomes zero.
- No explanatory legend paragraphs (LIFE, rate, color, monitoring) below rows; keep aligned headers and meaningful row states.
- Beneath every red row, state the real blocker and its corrective owner/action.
- Genuine task failures and confirmed infrastructure failures keep their original classifications and denominators; unscored cancellations, skips and unknown classifications go in one coverage note, never converted into agent or infra failures.
- Exact prompt, diff, approval and evidence payloads keep their required format and bytes.

## Work versus waiting

- Every scorecard and timeline separates **active agent work**, **running automation** and **waiting**, never lumping them as "fixes / other".
- Active work needs recorded implementation, diagnosis, coordination or reporting intervals; a running test or unattended job is automation, and token use or an open process proves neither.
- Record each wait's start, end and specific reason (user answer/approval, credits/quota, provider response or rollout, queue, dependency, other inactivity) on the original clock, as mode changes happen.
- Close an agent's work interval when it stops working; independent work that continues gets its own lane.
- Never hide a wait inside a repair bar or count overlapping work twice; a wait overlapping productive work on another lane stays visible but is not fully stalled wall time.
- Unrecorded time goes only under waiting as **Wait — reason unrecorded**, an accounting convention (historical records included), not proof that an external system caused the gap; never invent retrospective activity, credit shortages, user delays or start/end timestamps.
- Factory workflows record intervals with `scripts/record_factory_event.py` `work-start`/`work-finish` and `wait-start`/`wait-finish`, passing the same `--detail request_id=<interval-id>` and `--detail run_id=<original-run-id>` on both ends plus a short nonsecret `--detail reason=<reason>`: work `implementation`, `diagnosis`, `coordination`, `reporting`; wait `user`, `credits`, `provider`, `queue`, `dependency`, `inactive`.
- Native stage receipts supply automation intervals; `scripts/deploy_timeline.py` pairs native activity records into interval unions, keeping parallel waits, and unmatched records have unknown duration.
- Show wall-clock work and wait totals, with automation separate from human/agent effort.

## Colors and publication

- Color the text itself, not just emoji or diff prefixes: green verified successes and healthy checks, red failures and blockers, blue active work and headings, amber warnings and unmeasured coverage.
- Keep status markers, signed rate colors and one status emoji per agent; never rely on color alone or color an unknown result as pass or failure; active work is not a verified outcome.
- Color never alters classifications, measurements, original clocks or sections.
- Publish every scorecard as HTML by default: on boxes.dev, a self-contained CSS-colored visual through the `boxes-inline-visualizations` skill, previewed in light, dark and 360px layouts first; this overrides diff-fence progress cards but never exact approval packets or evidence payloads.
- Put the Markdown visual link alone in a final-answer paragraph so boxes.dev embeds the live card, with readable text and a compact first view; keep QA screenshots private and never send image previews.
- Only when embedding or rendered HTML is unavailable, use text or diff-highlighted code blocks and say so, never claiming emoji or prefixes colored the text.

## Resources and blockers

- Show timestamped Machine started/stopped counts and separately verified idle and warm counts; preserve designated warm Machines.
- Charge idle started VMs at the running rate and separate stopped rootfs from allocated-volume storage; identify estimate coverage, rates and unknown billed usage, never inventing an invoice total or billing provisioned maximum rootfs.
- Close each run's idle compute through the normal exact-owner stop guards (retained evidence or warm storage needs no running controller), and report confirmed STOPPED apart from requests and pending transitions.
- For a blocking provider or resource limit, name the exact limit, observed usage, numeric cap when actually known (app usage versus organization-wide quota) and the concrete action the owner or user can take.
- Justify capacity from measured workload and reuse evidence; a symbolic planner maximum never justifies a quota increase, and owned idle resources and supported reuse are reconciled before recommending one.

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

### Descent speed change (user clarification)

Every scorecard build recomputes the running headline from its actual `generated_at`:
`LIVE ≤<3600 / (generated_at - latest consecutive producer finish)> iter/h`.
This is a provisional upper bound for one future completion, not an added
completed iteration. Include inter-experiment work and current running time.
Show the last measured completed finish-to-finish rate separately; a terminal
current experiment uses that measured rate as its headline. Missing, invalid,
future, nonpositive or nonconsecutive clocks remain UNMEASURED; never bridge a
gap, invent a finish or reset producer clocks to a render timestamp.
The compact headline retains `[avg Δ <signed percent> over last 5 completed runs]`.
Avg Δ uses five consecutive finished recorded experiments (four finish-to-finish
speeds), then takes the arithmetic mean of the three successive changes:
100 * (next_speed / previous_speed - 1). It is neither mean speed nor endpoint
change. Retain failed/cancelled finishes and all inter-experiment work. For
completed-rate and Avg Δ calculations only, skip the latest current running
experiment; never bridge missing/invalid finishes.
Fewer than five consecutive valid finishes show UNMEASURED with n/5 coverage.
Positive change is green with +, negative red with -, and stationary is 0.0%.
Keep the full Iterations/Hour and finish-to-finish definition in a secondary
line/title; the last ten rows and T- clocks are unchanged.

### All /descend scorecards: full-suite outcomes and measured telemetry

For every descent, render one segmented donut (cake) for the entire persisted
selected task order, using X individual run slots per task: N selected tasks
multiply by X gives the denominator (200 × 2 = 400 slots). Green means that
individual scored run passed; red means that individual scored run failed.
Gray means no scored result in an explicitly unfilled slot; unscored infra or
cancelled attempts may exist. Amber means missing, invalid or unknown receipt/history. One PASS plus one
FAIL contributes one green and one red slot, never a single task-level color.
Missing task rows are unknown, never assumed unrun. Label these historical
outcomes; keep X/X task qualification and final-source acceptance separate.

Use a stacked-area global timeline at original experiment finish clocks.
Its green PASS, red FAIL, gray no-scored-result and amber unknown layers each
use the full N × X slot denominator. Put visible PASS% and FAIL% labels beside
every valid recorded point; never use the scored-only KPI denominator here.
Missing snapshots are gaps in every layer; do not interpolate across them,
substitute slice percentages or invent earlier history. Preserve the existing greater-than-three-iterations
threshold and last-ten experiment rows. Remove current-slice outcome bars and
the lifecycle display section for descents; underlying lifecycle, custody,
release checks and unresolved issues remain intact. Generic benchmark displays
retain their existing contract.

Color the descent pass KPI green only above95%, yellow above80%, red otherwise.
Color infra green only below5%, red at or above5%; unknown is amber/unmeasured.
Pass uses scored PASS+FAIL as its denominator; infra uses original scheduled jobs.
Never turn unknown/infra outcomes into a scored PASS or FAIL.

Supply full-scope inputs explicitly:
`--iterations N --global-acceptance acceptance_ledger.json --selected-tasks selected_tasks.json --selected-tasks-sha256 <raw-file-SHA256> --global-runs X --global-history global_history.json`.
The selection uses `descend-selected-tasks-v1` ordered `rows[].name`; acceptance
uses `descend-rolling-acceptance-v1`, matching `task_count` and `k`, unique task
identities and `last_scored` receipts (legacy `last_two_known_scored` is accepted
only for X=2). Each scored receipt must carry its original campaign/job/run,
verdict, source commit, evidence SHA256 and terminal clock. History uses
`descend-global-history-v1`, matching selection hash/count/k and ordered
`snapshots[{experiment_id, finished_at, acceptance_ledger}]`; null ledgers are
gaps. Inputs are read-only and mismatched scope is refused.

Optional `--telemetry telemetry.json --telemetry-membership membership.json --telemetry-sources original-source-packet/ --telemetry-receipt telemetry-receipt.json --telemetry-receipt-sha256 <custodian-receipt-SHA256>` uses `descend-scorecard-telemetry-v1`,
matching `experiment_id`, `scheduled_jobs`, `covered_run_count`, unique
`cost_rows[{job_id, cost_cents, run_json_sha256}]` and unique
`latency_rows[{agent_id, request_id, ttft_seconds, total_seconds, source_sha256}]`.
Durations come from matched native start/productive-chunk/completion observations;
null means missing. Show quantiles with sample/run coverage. Cost is user-metered
agent LLM cost, summed once per original job; it is not total provider expense.
Azure/provider spend, infra and grounding stay UNMETERED without billing evidence.
A partial job-cost input cannot replace a full experiment aggregate. Never infer
latency from a timeout, configuration budget, canary, or unrelated run.

Telemetry membership uses `descend-scorecard-membership-v1` with original
experiment/job/task/fleet/root identities, raw run SHA256 and allowed source
log SHA256 entries. The consumer joins every job to canonical result rows and
checks the original export manifest, campaign summary, and native-log index
bytes under each shard directory. Numeric charges must match canonical job
costs. Native root identity must match the canonical agent and log index; no
child identity is inferred. Missing-agent records may supply no numeric timing.
The original source packet stays local; missing custody refuses telemetry.
First-productive-chunk and total-request p50 use the median; p95 uses nearest
rank, with separate sample coverage. Cake segments are grouped by outcome for
readability; each retains its original selected-task ordinal and tooltip.

Native timing values require a one-time offline producer replay with
`scripts/cloudbench_telemetry.py --membership membership.json --source-root 00=<original-export-root> --output telemetry.json --receipt telemetry-receipt.json --replay-owner <artifact-custodian>`.
Repeat `--source-root` for every recorded shard. The producer verifies full
manifest and original run file hashes, extracts only embedded native events,
joins root/request identities, subtracts original UTC timestamps and leaves
missing or conflicting boundaries null. Selected excerpts alone are not full
source proof. Its receipt binds input manifests/run hashes, producer code,
output bytes, custodian and replay time. Obtain the receipt hash from that
original replay custody handoff; never bless edited telemetry by recomputing
a receipt in the renderer. Rendering checks the pinned receipt and costs
without rereading large original run files every refresh. Captured embedded
logs can be incomplete; timing coverage is per observed request, not all calls.

For all /descend scorecards, publish the interactive HTML embedding only. Do
not send, attach, or display raster images/screenshots. Private DOM inspection
for counts, layout and overflow is permitted; do not emit screenshot output.

## Deploy scorecard: deploy-summary-v2

- Every deploy progress and final report populates `.claude/shared/deploy-scorecard-template.html` (`deploy-summary-v2`), keeping the CSS and layout of the user-approved visual https://boxes.dev/visuals/vis_1997f1fd05813cc9be440f44d5700ffe, in this order:
  1. Title with actual colored **SHIPPED / NOT SHIPPED** status.
  2. Elapsed time immediately below.
  3. One **WHAT DEPLOYED** box.
  4. One cumulative **DELEGATED** box: each handed-off failure's description and repair-agent link, with no attribution column or acknowledgement state, kept across refreshes and resume.
  5. One **EXTERNAL PROVIDER FAILURES** box: each unresolved **🚨🚨 EXTERNAL PROVIDER FAILURE — <provider>: <reason> — NEEDS FIXING** with its affected checks and evidence.
  6. One **FOLLOWUPS** box, only if follow-ups exist.
  7. Last, concise colored per-stage bars on **one shared elapsed-time axis**.
- This layout supersedes the general placement rules and older section/alert placement; only evidence-backed values, applicable stage rows and attempt intervals change, and a layout change needs an explicit user request and a new documented version.
- Never replace the boxes with a lane table or add production/validation hashes, observed/producer noise or a secondary deploy-owner-complete line; provenance stays in the underlying evidence.
- The timeline starts at the original durable deploy start and plots every stage and attempt from actual start/end instants on the same labeled ticks and scale, so concurrency, retries and gaps stay visible, in progress and final cards.
- Never normalize rows separately, reset clocks at retries or replace bars with duration totals; keep live intervals and unknown boundaries explicit without inventing timestamps.
- v2's only change from v1 is the work/automation/wait breakdown inside the timeline box: blue for recorded work and automation, amber for waits, a muted amber pattern for historical waits with no recorded reason, rows labeled as well as colored, and wait reasons visible.
- Failure ownership and provider exceptions follow `.claude/shared/deploy-failure-policy.md`; waived or failed checks never become PASS, and original measurements and native outcomes stay visible.
- An AgentCard production lane elected with `scripts/deploy production --skip-agentcard "<reason>"` stays visible as **SKIPPED — <reason>**: no PASS, cleanup or financial settlement, no other gate skipped, and original failures, cleanup obligations and unsettled funds preserved; sandbox lifecycle tasks are smoke rows.
- A benchmark scorecard may be linked as supporting evidence but never replaces this card or its timeline.
