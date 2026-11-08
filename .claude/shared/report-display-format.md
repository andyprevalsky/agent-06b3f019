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
