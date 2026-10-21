CONSTATNLY CHECK IN TO MAKE SURE YOU ARE ONLY COMPLETING THE VALIDATION CRITERIA AND GOAL ASKED OF YOU AND ANY CRITICAL ISSUES IN THE WAY OF YOU COMPLETING THAT WORK AND DEPLOYING. DONT GET LOST IN RABBIT HOLES, PRIORITIZE THE EXACT FIX AND ANY NECESSARY TO GETTING A FUCKING DEPLOY IN

CONSTATNLY CHECK IN TO MAKE SURE YOU ARE ONLY COMPLETING THE VALIDATION CRITERIA AND GOAL ASKED OF YOU AND ANY CRITICAL ISSUES IN THE WAY OF YOU COMPLETING THAT WORK AND DEPLOYING. DONT GET LOST IN RABBIT HOLES, PRIORITIZE THE EXACT FIX AND ANY NECESSARY TO GETTING A FUCKING DEPLOY IN

CONSTATNLY CHECK IN TO MAKE SURE YOU ARE ONLY COMPLETING THE VALIDATION CRITERIA AND GOAL ASKED OF YOU AND ANY CRITICAL ISSUES IN THE WAY OF YOU COMPLETING THAT WORK AND DEPLOYING. DONT GET LOST IN RABBIT HOLES, PRIORITIZE THE EXACT FIX AND ANY NECESSARY TO GETTING A FUCKING DEPLOY IN

WHEN COMMUNICATING TO THE USER, BE CONCISE, LET THE USER ASK FOR MORE CONTEXT IF THE USER WANTS MORE, OTHERWISE DO NOT OVERCOMMUNICATE. STRICTLY FOLLOWING USER COMMUNICATION PROTOCOL

Keep the user-facing conversation coherent. When another agent messages you, incorporate relevant information into the existing conversation and the user's current request; do not turn every agent message into a standalone status reply. Surface only material progress, blockers, or requested results, and distinguish internal coordination from messages intended for the user.

For code review or approval requests, never give file pointers (paths or line links); paste the exact diff in chat.

All user-facing code-block displays from any skill or command follow
`.claude/shared/report-display-format.md`: 12-hour America/Los_Angeles time
(PDT/PST by date), one status emoji per worker and recorded token usage.
Show current-assignment tokens spent and rolling 15-minute tokens/min instead
of PCT and pp/min. Count recorded input + output, including cached input; do not
double-count reasoning output or infer credits, cost or completion from tokens.
Keep LIFE at the far right; remove UPD and progress wheels. Preserve same-scope
usage history and original lifetime; less than 15 minutes reads warming <age>,
missing counters read UNMETERED. Beneath red rows, state the blocker and
corrective owner/action. Completed work and healthy monitoring need no false
stall alarm. No nulls or explanatory legends.
Benchmark cards start with the Experiment Number and numeric experiments/day
for this goal. Show only the latest three actual experiments with concise timing,
queue/verdict, cost/cache/LLM and lifecycle subrows, replacing the old standalone
active-run/progress/metrics and last-slice blocks. Preserve unknown classifications
and original clocks; never invent zero measurements or failures.
Color-code the card itself: green verified successes, red failures/blockers,
blue active work and amber warnings/unmeasured coverage. On boxes.dev render
actual CSS-colored text in a published HTML scorecard; diff highlighting and
emoji alone do not satisfy this request. Preserve every measurement and
classification. Keep approval packets' exact inline diffs unchanged.
`/descend` main-thread approval packets use `.claude/shared/approval-format.md`:
paste the exact diff inline and retain that format's required evidence/Scope
links. A file pointer never substitutes for the diff.


### Standing scorecard memory — all current and future agents

- Every future CLI benchmark uses the shared scorecard: headline **QUEUED / IN_PROGRESS / COMPLETED**, then **PASS / HARNESS FAILURE / INFRA FAILURE**; preserve genuine agent failures, cancellations and unknowns separately, keep the infra threshold in a minor note, and refresh on agent starts/completions, every fixed 15 minutes and benchmark-state changes. Follow `.claude/shared/report-display-format.md` and the CLI-emitted `.claude/shared/benchmark-report-format.txt`.
- Use actual text colors, latest **3** runs, Experiment # and launches/day,
  Pacific local time, one status emoji, no UPD/nulls, and LIFE far right.
- At the top, show elapsed time since the latest actual benchmark ended, from
  its producer terminal timestamp. Diagnostics, cleanup and card renders never
  reset it. A missing end stays UNRECORDED; an active benchmark shows RUNNING.
- Show the live HTML scorecard inline in the answer, with readable text and a
  compact first view; keep QA screenshots private and never send image previews.
- Show **current-assignment tokens spent** and rolling **15-minute tokens/min**
  in worker and parent rows, replacing percentages and pp/min. Use actual
  timestamped harness counters (input + output, including cached input), with a
  recorded baseline before the assignment. Preserve previous scopes and LIFE;
  show UNMETERED when counters or the scope baseline are unavailable. Never
  estimate tokens from text length, elapsed time or milestone percentages.
- Record verified milestones and outcomes separately: spending tokens is not
  evidence of completion, success, savings or billed dollars. Do not add
  reasoning-output tokens again when already included in output. Rates use
  same-scope counter differences over a full 15 minutes; show warming <age>
  before that, and never bridge a counter reset without verified continuity.
- Keep fixed-cohort receipt counts for long batches and original clocks. A new
  rendering or reread of old evidence must not create a usage or outcome delta.
- After publishing, atomically update the existing latest-card URL and fixed
  checkpoint fields together; do not create competing URL aliases.
  Refresh lifecycle labels from verified receipts; completed exports must not
  remain displayed as pending.
- State blockers plainly: exact limit, measured usage, known cap or explicit
  evidence gap, and what the agent/user can do. A planner ceiling is not a
  measured need for more capacity; reconcile reuse before suggesting more quota.
  For Fly, check authenticated organization settings (`machines_per_org_limit`)
  before asking the user to find the cap; app counts are not organization totals.
- Report Machines **started / stopped / verified idle / protected warm**
  separately, with timestamped counts and compute/rootfs/volume costs. Idle
  started Machines remain billable; stopped is not free storage. Preserve
  designated warm resources and never label all running Machines idle.
- Keep ownership matches, verified idle, reuse eligibility and qualified tasks
  separate. Ownership alone grants no reuse or cleanup authority; retain-policy
  resources stay protected.
- After each run, normally stop exact-owned terminal idle controllers once
  consumer/process guards pass. Retain data and warm capacity; credit compute
  savings only after actual STOPPED confirmation, never from a stop request.
- Failed, cancelled or interrupted work must not leave unused Machines running.
  Reconcile and stop verified idle owned task Machines as well as controllers;
  preserve their IDs, volumes, evidence and explicitly protected warm services.
  Reuse eligible existing Machines before any new allocation. Fresh-only flags
  must not bypass reuse; creating more requires measured unmet need after reuse
  and verified provider headroom. A limit error is not permission to retry creates.
  Agents blocked by Fly limits must continue safe work on existing Machines or
  local gates, coordinate supported reuse, and report the remaining allocation gap.
- Refresh native running/stopped counts after material cleanup before presenting
  them as current; keep older snapshots clearly dated and separate from live facts.
- Infra stop means **5% of the original scheduled total: 30 of 600**. Display
  `infra jobs / scheduled jobs`; never use finished attempts as denominator.
  Earlier wrong 1/1 stops are erroneous early aborts, not valid threshold hits.

# Rose Labs

**Rose is an RWLH: a Real World Long Horizon computer.** It is a computer that
works in the real world over long horizons on the user's behalf. Judge every
design, UI and harness decision by whether it makes Rose a better RWLH.

- Production: https://roselabs.ai
- Backend API: https://navi-j9a9.onrender.com
- API Docs: https://docs.roselabs.ai

## Sub-agent delegation

- Every agent-created thread title must start with the exact prefix `--ai--`; include it in creation instructions and have the child set and verify its title as soon as it starts, preserving the prefix on later renames.
- Sub-agents must inherit the parent agent's model, reasoning/effort level, and
  speed/service-tier settings. Do not silently substitute a lower-effort model
  or a different speed setting. Use automatic inheritance when supported;
  otherwise pass the parent's effective settings explicitly. Deviate only when
  the user explicitly requests different settings for that sub-agent.
  A tool's defaults or saved devbox settings are not proof of the active
  parent's settings; verify the effective parent settings before delegating.
  For boxes.dev managed threads, omitting execution flags inherits the source
  box's saved defaults, **not** the active parent thread's live settings. Read
  `threads options`, then pass the verified parent model, reasoning effort and
  speed explicitly with `--model`, `--reasoning-effort` and `--speed`. Verify the
  child's effective settings after launch; a prompt instruction is not
  configuration. Only for a live parent setting that cannot be verified, fall
  back to `medium` reasoning effort and the fastest available speed
  (`ultrafast` on boxes.dev). Inherit every setting that can be
  verified, including the model; do not silently accept catalog defaults. If the
  selected model does not support the required fallback, report that limitation
  rather than silently substituting another effort, speed, or model. Never
  claim a setting was applied when the platform cannot confirm it.
  Do not interrupt existing workers merely to inspect or change presentation.
- Use sub-agents maximally for independent work. Keep the main agent unblocked
  and focused on coordination and the critical path.
- Give each sub-agent ordered priorities, a clear deliverable, and a deadline
  or time budget. Monitor progress and reprioritize or narrow scope early so
  work completes on time.
- The user's north star goal must always take priority when assigning work,
  resolving tradeoffs, and deciding what to do next.

### Mandatory experiment iteration loop

1. Run the requested experiment on its recorded source and monitor its actual
   outcomes. Freeze `scheduled_total` from the original run manifest. Stop the
   exact owned run when `20 * infra_failed_jobs >= scheduled_total` (infra
   **>=5% of all scheduled benchmarks**, never of completed attempts).
   **For 600 scheduled benchmarks: 1 and 29 infra failures continue; 30 stops.**
   Count each scheduled job once; retries, completions and cancellations never
   change the denominator. Unknown outcomes and cancellations without confirmed infra evidence
   do not count. Preserve confirmed TRUE evidence across logical cancellation. Keep physical-attempt telemetry separately. Use the normal
   controller/traps and preserve the trigger, all attempts and original clocks.
   An explicit user threshold overrides this default.
2. Triage every error from each completed or stopped experiment, starting while
   it runs. Group independent first-bad causes, including recovered errors and
   errors on passing tasks. Assign a separate available sub-agent **`/RCA`** for
   each independent cluster; queue excess clusters explicitly. Do not funnel
   all causes through one author or wait for the complete batch to delegate.
3. Each RCA owner reads the methodology, uses runtime evidence, reproduces the
   owning failure, fixes it, makes the identical test pass and registers the
   regression. Verify the unchanged affected task/outcome before calling it
   fixed. A successful diagnostic or transport repair does not fix the original
   failure; an unreproduced cause remains an open observability gap.
4. The parent coordinates the critical path, reviews concrete proof and removes
   blockers while independent workers continue. Give every owner milestones,
   ordered priorities and a time budget. Use other available workers for
   independent hypotheses or reviews without competing edits or live queries.
5. When critical fixes are in progress and no useful independent work remains,
   **sleep**, leaving workers and operational monitors running. Wake on an
   actionable event or the fixed **15-minute** checkpoint. Check progress, send
   the full scorecard, take corrective action on stalls and ask what can be
   accelerated or parallelized; then sleep again if still waiting.
6. As soon as the critical repairs and affected checks are verified, rerun the
   original authorized experiment. Do not wait for unrelated RCA lanes, duplicate
   proof packets or a full `/deploy`. Repeat until the requested goal passes,
   then finish normal deployment, publication and verified owned cleanup.

Infra fixes do not require human approval. Existing approval requirements for
runtime/product changes apply only to the affected action, through the parent.
Do not change tasks, assertions, concurrency, timeouts or acceptance rules to
make an iteration pass.

### Waiting for delegated work

- Never sleep or wait for more than 15 minutes at once; wake sooner for new
  results or user input, and retain the fixed scorecard deadline.
- When the next action depends on a sub-agent and no useful independent work
  remains, sleep using an interruptible wait. Resume when a sub-agent reports
  meaningful progress, a failure, a blocker or a decision that needs action.
- Otherwise wake once every 15 minutes to check the assigned work and send the
  user the current scorecard, even when nothing changed. Use the workflow's
  existing scorecard format, retain verified values and show observation ages.
  Keep this reporting deadline independent of event-driven wakeups; sub-agent
  messages must not postpone the next 15-minute scorecard.
- At every 15-minute checkpoint, explicitly think about whether progress can
  be sped up: identify the current critical path, unnecessary waits and the
  smallest useful next experiment or check. Act on concrete opportunities and
  embed reusable learnings in the owning instructions or command. Include the
  chosen speedup in the scorecard, or state briefly that no concrete speedup
  was found. Then return to waiting; do not create status-only busywork.
- Verified lack of milestone gain is a control signal; token burn alone is not
  progress. Its row must name the blocker and the concrete action taken or
  already in flight.
  Narrow a failing hypothesis, remove a redundant dependency, split independent
  work, reassign an idle owner or choose a more discriminating experiment.
  If the same blocker persists at the next checkpoint without new causal
  evidence, change the approach; repeating the same explanation is insufficient.
  Never reset scope, milestones or start times merely to hide a stall.
- At every 15-minute checkpoint, explicitly ask: "Can any remaining work be
  parallelized to speed up iteration?" If yes, assign independent hypotheses,
  evidence analysis, regressions or reviews to available authorized sub-agents.
  One owner per cause does not mean one investigator. Keep one fix owner and
  coordinate live experiments so they do not interfere. Include the resulting
  parallel assignments in the scorecard, or the concrete dependency or resource
  constraint that requires serial work.
- After each scheduled check, return to waiting if nothing actionable changed.
  Between checks, do not busy-poll, repeat unchanged reports, send status nudges
  or create extra audits just to remain active.
- This idle-wait rule takes precedence over frequent parent reporting or polling
  cadences. Active workers still own any required operational monitoring and
  cleanup; waiting does not cancel their work or reset its clocks.
  A user question, scorecard edit or parent-side discussion does not pause
  active workers. Stop a worker only when the user actually cancels its work,
  its own safety boundary requires it, or a coordinated reassignment needs it.
- Sub-agents should batch routine status updates and notify the parent when an
  actionable milestone, result, failure or blocker occurs. Keep other idle
  checks quiet; the scheduled 15-minute scorecard is still required.
  Compute refs and hashes before sending a handoff; do not send placeholders
  that require corrective follow-up messages.
- Report infrastructure failures immediately when the first authentic failure
  is observed; do not wait for the full campaign, suite or 15-minute scorecard.
  Include the exact run/task/attempt, first failing boundary and available
  original evidence. Start diagnosis and the owning regression while healthy
  independent work continues. Preserve all attempts, classifications and clocks;
  an early failure report does not authorize a restart or broader cancellation.
- Verify early stopping and parent notification separately: redirected step
  output or an unattended background sampler does not wake the parent. Reuse
  the existing observer for idempotent first-failure and terminal notifications.
  Also report the first verified shared-dependency failure through that observer
  so RCA starts before terminal task failures. Keep such warnings separate from
  terminal-attempt counts and preserve the existing cancellation predicate.
  Select the first failure from original physical attempts even when the logical
  member was cancelled; preserve the trigger and delivery receipts.
- Verify a monitoring handoff with the successor's actual owner receipt and
  first source-bound sample before reporting it active. Prepared configuration
  and predecessor success do not prove successor execution. Report startup or
  exec failures immediately through the existing notification path. When
  re-executing Python, preserve the absolute `sys.executable` as `argv[0]`;
  relocated interpreters can otherwise resolve a missing standard library.
  Repair only the observer setup, keeping one reader and the original clock.
- In bounded observations, capture canonical first-failure logs and stop
  receipts before rotating partial metadata. Record capture completion only
  after the exact file has a successful, hash-bearing copy receipt; startup
  log copies do not complete failure capture. Test the sampler and copier
  that execute, including file/byte limits and late-arriving receipts.
- For experiment iteration, including the remaining simultaneous 600-task
  qualification, the >=5% denominator is the **original scheduled total**:
  `scheduled_total > 0 && 20 * infra_failed_jobs >= scheduled_total`.
  At 600 scheduled jobs, stop at **30 confirmed infrastructure-failed jobs**;
  a first failure among one completed attempt is **1/600, not 1/1** for this rule.
  Count each scheduled job once and retain separate physical-attempt/retry
  evidence. Do not shrink the denominator to terminal attempts, change it as
  work completes, or infer infra failure from unknown/cancelled status alone. Preserve confirmed
  TRUE evidence across logical cancellation. As soon
  as the fixed-total predicate is met, cancel that exact owned campaign through
  its normal controller/traps and repair the critical causes before retrying.
  Fence the controller identity; never signal unrelated campaigns. Preserve
  earlier erroneous early stops as aborted runs, never retroactive passes.

### Experiment iteration speed

- Before an experiment, name the hypothesis, the result that would distinguish
  it, its original bounds and the next decision. Afterward, update the owning
  RCA from the observed result. If it passes without reproducing the reported
  failure, keep that failure open and choose a different discriminating check;
  do not promote diagnostic completion into outcome progress or blindly retry
  the broad run.
- Review a concrete candidate once against the actual diff, causal proof,
  registered regression and required runtime binding. Return blocking findings
  together. Review again only for changed bytes, a failed check or a named
  unresolved risk. Accept already verified unchanged dependencies and existing
  authorization; do not make repeated hashes, packet rewrites or additional
  parent acknowledgements into new execution gates. Verification remains
  mandatory; serial bookkeeping is not a replacement for fixing the failure.
- When iterating on infrastructure or an experiment, never block the next
  experiment on a full `/deploy`. The user reports that a full deploy costs
  roughly three hours. Keep experiment prerequisites separate from deployment
  qualification: run the smallest checks that establish the changed behavior
  and the experiment's actual dependencies. Full deployment gates remain
  required when deploying; they are not an automatic experiment prerequisite.
- Continuously improve iteration speed. At launch, at meaningful milestones
  and during scheduled checks of long executions, think critically about the
  critical path: what is this wait proving, what evidence already exists, and
  what smaller or earlier check would let the next useful experiment start?
  Act on concrete improvements instead of repeatedly waiting through the same
  slow sequence. Preserve the quiet-wait and scorecard cadence above; reflection
  does not justify busy-polling or extra status-only agent turns.
- Use an owning causal regression before a broad experiment, report authentic
  infrastructure failures immediately, and stop a disqualified run under its
  applicable user-defined threshold. Preserve the original failure evidence
  and verify the repair before retrying. Do not wait for unrelated gates or
  the rest of a run to finish before diagnosing an observed failure.
- Reuse verified, source-bound results for unchanged dependencies; rerun checks
  affected by the change. Reuse supported isolated environments and healthy
  dependencies, and overlap genuinely independent work when resources permit.
  Do not weaken assertions, change acceptance criteria, hide failed attempts or
  claim that an experiment tested a repair absent from its actual service path.
- Reuse an age-limited precheck only from its normal successful producer and
  authenticated source/environment evidence. Preserve the exact artifact bytes
  and original timestamp used by its TTL; copying must not refresh its age.
  Record origin and destination, keep normal expiry checks, and rerun the
  precheck when expired. A restored cache is not a new execution or proof of
  greater capacity than the original check measured.
  Before fanout, compare the remaining TTL with the observed startup delay
  until members recheck that artifact. If startup would consume its remaining
  lifetime, run the normal precheck before fanout instead of restoring a
  near-expiry cache. Never refresh the timestamp to avoid that normal check.
- Campaign and publication-group identities must be unique across hosts and
  original experiment epochs. A local PID alone is not globally unique. Bind
  the namespace to the original epoch and native boot identity before publishing,
  and check the same-PID/different-host case without a paid experiment. Preserve
  prior identities and rows; repair the producer's namespace rather than
  weakening ownership checks or overwriting another run's membership.
- Where supported, run an already-required shared precheck through its normal
  producer before creating hundreds of local controllers that would wait on it.
  Reuse its genuine source-bound result within the original TTL and experiment
  deadline. This changes scheduling; it must not add a new qualification gate,
  fabricate a passing result or change the selected tasks and their profiles.
  Bind its generated operator limits to the campaign's normal planner, selected
  profiles and observed baseline. Recompute stale generated limits through that
  supported planner while preserving explicit user ceilings and native admission
  checks. Derived local defaults do not certify provider quota or capacity.
- Embed each reusable speed improvement in the owning instructions, runbook,
  command or regression so the next similar experiment starts with it. Record
  the exact setup, source/service binding, applicable scope and observed timing
  when available. Turn recurring manual steps into small supported commands;
  do not leave the learning only in chat or a private agent's memory.

### Delegated workspace lifecycle and disk ownership

- A new thread does not need a new worktree. Read-only reviewers and triage
  workers should use an existing immutable checkout without installing
  dependencies or copying datasets. Give editing workers isolated worktrees
  when concurrent edits require them; do not share a mutable checkout.
- The parent owns workspace retirement. Record each child's exact owned paths,
  source SHA, resource/process owners, expected disk footprint and retirement
  condition at dispatch. Coordinate with other parent threads on the same box;
  keep one owner per shared infrastructure cause and never clean up their work.
- Keep new worktrees small: reuse matching healthy dependencies and avoid
  materializing historical datasets that the assigned consumer does not read.
  Preserve canonical/Git copies. Restore the complete required history before
  any consumer that needs it; never substitute empty history or weaken a test.
  Check actual shared disk headroom, existing reservations and the planned peak
  footprint before allocating another checkout, installation or test fixture.
- Workspace retirement is part of completing a delegation. First preserve its
  changes in a durable Git ref and retain required original evidence, receipts
  and unique files outside the retiring workspace. Compress or publish sealed
  evidence as appropriate; preserve private permissions and never publish
  secrets. Then verify that no live process, mount, publisher, benchmark or
  recovery operation still consumes that exact workspace or its resources.
- After those checks, remove only the child's owned temporary artifacts and
  clean worktree, using the supported ownership-aware teardown for services,
  databases and provider resources. Preserve canonical dependencies, shared
  caches, other threads' assets, Freedom and protected instructions. Do not
  force removal of dirty, locked, unknown-owner or still-needed paths.
- A finished or idle thread is not cleanup evidence. The parent verifies and
  records actual retirement and reclaimed bytes. If retention remains necessary,
  record its owner, exact paths, reason and next retirement condition instead
  of silently abandoning the workspace. Keep thread history and durable evidence;
  retiring a workspace does not mean deleting the conversation.

## Architecture

```
front-end/        → React/TypeScript/Vite (Vercel)
back-end/         → Express/TypeScript/Prisma (Render)
agents/           → Python Temporal workers (Fly.io)
research/gepa/    → Offline reward-model pipeline (no runtime services)
mac-app/          → Electron desktop app (macOS only)
docs/             → API documentation (Mintlify)
claude-code-src/  → Vendored Claude Code source (READ-ONLY reference). Its
                    prompts and agent loop are extensively battle-tested;
                    our repo is still at the 0-users stage. Lift patterns
                    liberally when designing or refining our agent harness.
openclaw/         → Cloned OpenClaw repo (READ-ONLY reference, gitignored —
                    not committed to keep parent repo lean). Open-source
                    agent harness; useful prior art for tool layouts, system
                    prompts, and orchestration patterns. Re-clone with
                    `git clone --depth 1 https://github.com/openclaw/openclaw.git`
                    if missing locally.
hermes-agent/     → Cloned Nous Research hermes-agent (READ-ONLY reference,
                    gitignored). Reference implementation for tool-calling
                    + reasoning prompts. Re-clone with
                    `git clone --depth 1 https://github.com/nousresearch/hermes-agent.git`
                    if missing locally.
codex/            → Cloned OpenAI Codex CLI (READ-ONLY reference, gitignored,
                    Apache-2.0). Terminal coding agent harness; prompts live
                    under `codex-rs/prompts/` + `codex-rs/core/*_prompt.md`.
                    Re-clone with
                    `git clone --depth 1 https://github.com/openai/codex.git`
                    if missing locally.
prime-agent/      → Cloned Prime Intellect prime-agent (READ-ONLY reference,
                    gitignored, MIT). Recursive-language-model harness: one
                    persistent Python REPL tool, every other tool/subagent a
                    Python call, plus self-edited memories/skills. System
                    prompt layers live under
                    `crates/pa-core/src/prompts/layers/`, skills under
                    `skills/`, the kernel under `prime-agent-runtime/src/rlm/`.
                    Re-clone with
                    `git clone --depth 1 https://github.com/PrimeIntellect-ai/prime-agent.git`
                    if missing locally.
```

> **Reference repos policy:** `openclaw/`, `hermes-agent/`, `codex/`, and `prime-agent/` are gitignored
> (sit alongside `claude-code-src/` but are NOT committed). Treat as
> read-only research material — do not edit them. If they're missing on a
> fresh clone, run `bash scripts/sync-reference-repos.sh` to restore.

## Prompt review tool

`prompt-review/` ships a small local web app for reviewing every prompt in
this repo against reference codebases side by side. Columns:
**current → ~1 month ago → Claude Code → OpenClaw → Hermes → Codex → Prime Agent**. Notes are
saved per prompt; checkpoint state persists across reloads.

```bash
bash prompt-review/run.sh                     # rebuilds data + launches on :8765
PROMPT_REVIEW_PORT=9000 bash prompt-review/run.sh   # custom port
```

- Catalog: `prompt-review/catalog.json` (edit to add/remove prompts).
  Each OUR entry has a `matches` field with hand-picked semantic pairings
  for each reference repo (`claude`, `openclaw`, `hermes`, `codex`, `prime`); a value of
  `null` means "no equivalent in that repo" and the column shows
  "no equivalent" instead of a low-quality keyword match. Edit
  `prompt-review/render/apply_explicit_mappings.py` to refine pairings.
- Build: `python3 prompt-review/build.py` (extracts text + git history +
  resolves matches via explicit mapping first, keyword fallback otherwise).
- Notes/checkpoints: `prompt-review/checkpoints/state.json` (gitignored)
- Weak matches (no good correlary in the reference repo) get a teal `WEAK`
  flag in the column header. Match-source badges: blue `manual` (explicit
  semantic pairing) vs gray `auto` (keyword fallback).

**Key entry points:**

- `front-end/src/App.tsx` - React app
- `back-end/src/server.ts` - Express server
- `agents/worker.py` - Temporal worker
- `agents/workflows/agent_workflow.py` - Core agent logic
- `back-end/prisma/schema.prisma` - Database schema (source of truth)
- `back-end/src/providers/rose/client.ts` - In-process Rose completions (chat path)
- `agents/providers/rose/client.py` - In-process Rose completions (agents path)
- `mac-app/main/index.ts` - Electron main process
- `docs/mint.json` - Mintlify docs config

**Mac app releases:** PRs that include `mac-app/` changes should be labeled `MAC-APP-RELEASE`. When a PR with this label is merged, CI automatically bumps the patch version, creates a git tag, and pushes it — which triggers the full release workflow (build, sign, notarize, upload). No manual tagging needed. You can also trigger a release manually by pushing a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`). **Any `front-end/` changes also require a mac-app version bump** (new git tag push) so the Electron app rebuilds with the updated frontend.

## Development

Run all services via Conductor (see `conductor.json`).

### Fresh clone setup (Andy’s Mac)

Read this file completely and honor `AGENTS.md` before setup. Secrets are not
committed. The authoritative local env files live under
`/Users/andyprevalsky/conductor/repos/navi-whisper-lux-v2/`. Copy or symlink
`agents/.env`, `back-end/.env`, and `front-end/.env` into the same relative
paths in the clone; also restore `mac-app/.env` on macOS and `research/.env`
when doing research. Never print or commit their contents. Verify that
`BACKEND_API_KEY` is present and agrees between agents and backend without
printing it. The `.env.example` files are safe references, not complete
substitutes for the authoritative files. For credential reconciliation, follow
**Production Env Vars** below, including the Codex-cloud `rose` environment.
Exact cloud cancellation must also read the browser provider credentials from
these env files. Its credential loader accepts a symlink to a regular
authoritative env file; cleanup evidence and receipts remain symlink-free. If
recovering an older controller that rejects linked env files, materialize
private `0600` copies before retrying its exact-owner recovery.

Keep the checkout outside iCloud-synced Desktop or Documents; prefer
`~/Developer/<unique-clone-name>`. Evicted `dataless` files can stall Git and
Python or make a Git pack appear empty even though `ls` reports its full logical
size. Finder's **Keep Downloaded** does not repair an already stalled iCloud
sync; a fresh clone on local storage avoids that dependency.

Before installing anything, inspect an existing healthy Developer checkout
(the installed trees in `~/Developer/rose-pr1299` were verified). Reuse them
when the root/workspace `package.json` files, committed package lockfiles and
`agents/requirements.txt` match, with the same platform and pinned toolchains.
Preserve the installation's layout: npm workspaces may hoist packages such as
`dotenv` into root `node_modules`, while package-local installs keep them under
`back-end/node_modules`. Link the existing root tree **and** each existing
package tree into the same relative paths, plus the matching `agents/venv`;
package trees alone do not reproduce a hoisted installation. Keep healthy trees
and lockfiles intact. Activate the reused venv so child `python3` uses it too.

Start Docker Desktop. Use Python **3.11.9** for `agents/venv` and Node
**20.10.0** for the Mac app (`source ~/.nvm/nvm.sh`, `nvm install 20.10.0`,
`nvm use 20.10.0`). Select the installed Python 3.11.9 explicitly when an asdf
shim points elsewhere. When no matching healthy installation is available,
install backend, frontend, and Mac app dependencies in
their package directories with `npm install`; create `agents/venv` with
`python3.11 -m venv venv` from `agents/`, activate it, and run
`pip install -r requirements.txt`. Run `bash scripts/sync-reference-repos.sh`.
Fleet controllers require modern Bash (`brew install bash`, then put
`/opt/homebrew/bin` before `/bin` on Apple Silicon); macOS’s bundled Bash 3.2
does not provide their `mapfile`/associative-array operations.
Backend/frontend dependencies may require a newer Node than the Mac app; use
an installed compatible Node (22.13.0 was verified) for those packages and
retain 20.10.0 for `mac-app`.
Isolated macOS benchmarks use a separate Docker Postgres server per run. Keep
the automatic system-Postgres fallback limited to Linux; separate databases on
one system server still share its connection limit during parallel smoke runs.
Keep the Mac awake during long validations. `caffeinate -is` prevents idle sleep,
but closing the lid on battery can still suspend the controller and local
WebSockets while cloud tasks continue. Check `pmset -g log` before treating a
long wall-clock gap as a provider timeout.

If npm workspace resolution fails, use each package’s committed lockfile with
`npm ci --workspaces=false` in `back-end/` and `front-end/`, as documented in
the RCA `2026-07-24-root-npm-install-ignored-workspace-lockfiles`. Do not delete
lockfiles or change dependency ranges to get a fresh clone installed. If pip’s
resolver stalls, `uv pip install --python agents/venv/bin/python -r
agents/requirements.txt` installs the same requirements into the same venv.
After installing backend dependencies, run `npx prisma generate` from
`back-end/` before database setup; schema push alone does not generate the
client used by the seed/index scripts.
For direct agent tests, run from `agents/` with `source venv/bin/activate`;
an absolute venv Python alone leaves subprocess `python3` on the asdf shim.
Before a fleet run, or before starting an image-build-to-fleet measurement,
select the installed backend/frontend Node (22.13.0 was verified), activate the
agents venv, and run this cheap check from the repository root:

```bash
(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts'); console.log('backend seed-cache imports ready')")
```

This imports the actual canonical seed-cache producer through its installed
TypeScript loader and dependency graph, allowing both npm layouts. It does not
invoke the seed CLI, read its env file, contact R2 or start a stack. Resolve a
failure before starting the measurement; an image-only publication needs no
backend import check. See RCA
`2026-10-07-controller-worktree-omitted-hoisted-root-dependencies`.
Install the matching browser once with `python -m playwright install chromium`
inside that activated venv before browser blackbox tests.
Use the browser-use version pinned in `agents/requirements.txt`: native
navigation must forward the event's timeout to CDP. The browser blackbox checks
that actual path and rejects a global asyncio patch. Resolve Python dependency
changes against the complete manifest and run `python -m pip check` before
refreshing cloud dependency snapshots; an old pool fingerprint cannot certify
the new environment.
On Mac, a failed Docker database setup must stop before any shared-system-PG
reset. `scripts/tests/setup-db-concurrency.test.sh` covers that boundary.
For explicit isolated coverage URLs, use `BACKEND_COVERAGE_DATABASE_URL` with
a local `victoria_<workspace>` database inside a verified owned server.
The worker blackbox covers optional CDP timeouts, recording cleanup drain and
strict rejection of unrelated pending tasks; expired optional CDP children
remain owned by the bounded worker event-loop shutdown.

In Conductor, use `.conductor/settings.toml`; it supplies workspace variables,
links env files from `$CONDUCTOR_ROOT_PATH`, and runs `scripts/setup-db.sh`.
For a standalone clone, choose an unused base port and a unique directory name
(the workspace name normally matches the directory basename), then run:

```bash
export CONDUCTOR_PORT=<unused-base-port>
export CONDUCTOR_WORKSPACE_NAME=<clone-directory-name>
export CONDUCTOR_ROOT_PATH="$PWD"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
bash scripts/setup-db.sh
bash scripts/run.sh
```

Use the same variables for setup and startup. Setup resets only that workspace’s
local Postgres database and seeds it from production; the backend env must have
production DB credentials. Do not reuse another workspace’s name or ports.
The loopback proxy exclusions keep Python local health/test requests local
when macOS has a system HTTP proxy; do not disable the user's proxy application.
For Linux/cloud, use **Cursor Cloud / Linux dev environment** below instead:
prefer complete `AGENTS_ENV_B64` / `BACKEND_ENV_B64` secrets (optional SHA256
checks), configure both ngrok secrets, run `bash scripts/cloud-init.sh`, and
never install or run `mac-app` there.

A schema change can require a new canonical cloud seed cache key. Cloud guests
use PostgreSQL 15: migrate the previous reviewed canonical fixture in an
isolated PG15 database, preserve its row content, and validate with
`scripts/validate-canonical-seed-dump.sh` before publishing via
`back-end/scripts/seed-dump-cache.ts`. Use `scripts/save-seed-dump.sh` with that
PG15 container and verify a restore/read-back. Never publish a coverage database
or replace the reviewed WhatsApp history with a production cold sync. See
`docs/rca/cases/2026-08-20-poisoned-canonical-seed-missing-whatsapp-history.md`.
Local system-Postgres benches need the matching client tools on `PATH` after
selecting Node. For a Homebrew PostgreSQL 17 server, prepend
`/opt/homebrew/opt/postgresql@17/bin`; a PostgreSQL 18 client from Postgres.app
otherwise selects a different canonical cache key. If a PG17 cache is missing,
restore the reviewed canonical fixture into an isolated PG17 database, verify
table content and a dump/restore round trip, then publish that version's key.

### Disk hygiene after a deploy/benchmark session (Andy’s Mac)

The 926 GB data volume filled to 100% on 2026-10-06 and Docker Desktop wedged
in `Docker: stopping` (every workspace lost its DB container; a smoke lane died
with `ENOSPC`). Check `df -h /System/Volumes/Data` before Group 3/4 lanes and
clean up when you finish. Only touch your own workspace’s `.context`, never
another workspace’s, never Freedom.

- **This workspace:** `rm -rf .context/benchmarks/<run-id>` for finished
  isolated runs (keep `seed-cache`; check `local-stack-owner.json` pid is gone),
  `rm -rf .context/frontend-builds/<run-id>` (~400 MB each), and
  `git worktree remove --force .context/main-tree && git worktree prune` if a
  main-comparison worktree was created.
- **Chats older than one week — compress, keep, destroy the raw:** Claude Code
  `find ~/.claude/projects -name '*.jsonl' -mtime +7 -exec gzip -9 {} +`; Codex
  `find ~/.codex/sessions -name '*.jsonl' -mtime +7 -exec gzip -9 {} +`
  (`gzip` keeps the compressed file beside the old name and removes the raw).
  `~/.claude/gen/codex/transcripts` is already gzip; delete entries older than a
  week only when `~/.claude/gen/codex/events/<today>.codex_uploader.jsonl`
  shows `upload.cycle` `"ok":true` with an empty spool — the uploader was
  returning `server_5xx` on 2026-10-06, so those were kept.
- **Conductor chats** live in
  `~/Library/Application Support/com.conductor.app/conductor.db`
  (`session_messages`, 9.5 GB / 2.6 M rows in Oct 2026). Quit Conductor first,
  then archive and compact:
  `sqlite3 -readonly conductor.db ".mode json" "SELECT * FROM session_messages WHERE created_at < strftime('%s','now','-7 days')*1000" | gzip -9 > ~/Archives/conductor-chats/$(date +%F).jsonl.gz`,
  then `sqlite3 conductor.db "DELETE FROM session_messages WHERE created_at < strftime('%s','now','-7 days')*1000; VACUUM;"`
  (confirm the `created_at` unit with `SELECT MAX(created_at)` first; freelist
  is 0 without the delete, so `VACUUM` alone reclaims nothing).
- **Docker:** `docker builder prune -f` and `docker image prune -f` only.
  Never `docker system prune` — it removes other workspaces’ stopped DB
  containers. `Docker.raw` (~115 GB on disk) is every workspace’s volumes.
- **Updater leftovers are safe:** `/var/folders/*/T/*.ShipIt.*` and
  `~/Library/Caches/*ShipIt*` are stale app-update staging (GBs). Leave
  `~/Library/Caches/ms-playwright` (tests need it) and running apps’ caches.
- **Large but functional (ask before removing):** Claude desktop
  `vm_bundles/claudevm.bundle` (10 GB, re-downloadable), Cursor
  `User/globalStorage` (8.6 GB chat/AI state), `~/.codex/thread_history_*.sqlite`.
- If Docker is already wedged: `osascript -e 'quit app "Docker Desktop"'`,
  `pkill -TERM -f com.docker.backend` if it lingers, `open -a Docker`, then
  `docker start victoria-db-<workspace>` — containers come back `Exited (255)`.

**Tests:** See `docs/testing.md` for the full guide. Quick:

```bash
bash scripts/test.sh --port=3001                   # everything: offline + smoke + semantic (requires running services)
bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + semantic)
bash scripts/test.sh --no-smoke agents web-search  # single repo/domain (offline)
bash scripts/test.sh --list                        # list available repos/domains
```

**Backend tests (direct):**

```bash
cd back-end && npm run test:api         # Backend API tests
cd back-end && npm run test:coverage    # Backend coverage check (enforces thresholds)
cd back-end && npm run test:coverage:report  # Coverage report without threshold enforcement
cd front-end && npm run test            # Front-end blackbox + structural tests
cd front-end && npm run test:coverage   # Front-end coverage check (enforces thresholds)
cd front-end && npm run test:coverage:report  # Front-end detailed coverage report
cd mac-app && npm run test:coverage     # Mac-app coverage check (enforces thresholds)
cd mac-app && npm run test:coverage:report  # Mac-app detailed coverage report
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py  # Agent blackbox tests
cd agents && python tests/e2e/run_e2e_tests.py --basic  # E2E agent tests (spawns real agents via API)
cd agents && bash scripts/run-coverage.sh            # Agents coverage check (enforces fail_under)
cd agents && bash scripts/run-coverage.sh --report   # Detailed report without threshold
cd agents && bash scripts/run-coverage.sh --html     # HTML report in htmlcov/
cd mac-app && npm run test                   # Mac-app blackbox suite (vitest + MSW, jsdom)
cd mac-app && bash scripts/run-blackbox-tests.sh <domain>  # Mac-app blackbox: single domain
```

**Code coverage:**

- **Backend** requires minimum 88% line/statement, 87% function, 76% branch (see `back-end/.c8rc.json`).
- **Front-end** requires 80% lines, 75% statements/functions, 70% branches (see `front-end/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines, ~79% statements, ~77% functions, ~72% branches. Target: 80% across all four.
- **Mac app** requires 80% lines/statements/functions and 85% branches (see `mac-app/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines/statements, ~84% functions, ~85% branches. Thresholds ratchet up and never down.
- **Agents** requires 80% line+branch (see `agents/pyproject.toml` → `[tool.coverage.report]`). Current: 81%.
- Thresholds ratchet — only increase, never decrease. Bump after adding tests.

**Benchmarks:** `scripts/run-bench` is the one supported entrypoint for humans,
`/benchmark`, and `/descend`. Before any benchmark, cloud fleet or cloudbench
work, invoke the `/benchmark` skill: it carries the full operations runbook
(scorecard contract via `scripts/run-bench report-format`, fleets and pools,
monitoring, exact-owner recovery, LIVE campaign acceptance). Quick reference:
`scripts/run-bench list`, `scripts/run-bench <task> --wait`, and
`scripts/run-bench <task> -k K --concurrency N` for K independent copies.

- Every time a benchmark task is run, include the valid FE link to view the run (for example, `http://localhost:5050/?agent-id=ac267c32-470f-41da-8343-091b8965c410`) and verify it actually displays the agent.

## Cursor Cloud / Linux dev environment

Cloud agents run on Linux. **Read this whole file first**, and use the repo's own
skills by default — the `.claude/commands/*` slash-commands (`/deploy`, `/RCA`,
`/benchmark`, etc.) and the `docs/` guides they point to (e.g. `/RCA` →
`docs/root-cause-analysis.md`, testing → `docs/testing.md`). These are the source
of truth; do not duplicate them into other files.

- **Setup / refresh (run at the START of every cloud session):** `bash scripts/cloud-init.sh`.
  It is idempotent and reuses the battle-tested Fly-cloudbench pattern
  (`scripts/cloudbench-entrypoint.sh`): (1) decode the injected
  `AGENTS_ENV_B64` / `BACKEND_ENV_B64` secrets into `agents/.env` / `back-end/.env`
  (whole-file base64, optional `*_ENV_SHA256` check — no per-key drift), (2) run
  `scripts/cloud-build.sh` (root `npm install` + `prisma generate` + `agents/venv`
  - local Postgres), and (3) **seed the local DB from prod** via
    `back-end/scripts/seed-local.ts` so a cloud agent never starts against an empty
    database. Missing secrets / a failed seed WARN and continue (never abort). The
    seed is skipped when the dev user already exists.
    `scripts/cloud-build.sh` alone remains the minimal deps-only provisioner if you
    do not need `.env`/data materialized.
- **Database:** Docker is typically unavailable on the Cloud VM, so the stack uses
  **system PostgreSQL** at `localhost:5432` (`postgres`/`postgres`, db `victoria`);
  `scripts/run.sh` falls back to it. The backend blackbox and coverage runners
  use their own `victoria_<workspace>` database on that server (created on
  demand), never the shared `victoria`. Start it with
  `sudo service postgresql start` if needed.
- **Toolchain:** `agents/venv` uses Python 3.11 (the pinned version; system
  `python3` may be newer). A few suites also need `ruby` + `rsync` installed
  (deploy-gate + cloudbench tests) — otherwise you'll see `ruby: command not
found` / `rsync: command not found`.
- **Cloud fleet controller:** Follow the long cloud fleet proof guidance in
  `docs/testing.md` for the dedicated-CPU controller requirement, exact-owner
  recovery, and warm snapshot reuse before starting width-10 validation.
- **Skip `mac-app` on Cloud/Linux — tests AND `dev`.** It is macOS-only (Electron
  - `darwin`-only native deps such as `node-mac-contacts`); its `npm install`,
    `npm run dev`, and blackbox suite cannot run on Linux. `run.sh` and the husky
    pre-commit hook already skip it on non-Darwin. Do mac-app work on macOS only.
- **Running services directly (no ngrok/secrets):** backend
  `cd back-end && PORT=<N> npx tsx watch src/bootstrap.ts`; frontend
  `cd front-end && npx vite --port <N+1>`. In dev the frontend infers the backend
  as `frontendPort - 1` (see `front-end/src/lib/backendUrl.ts`) unless
  `VITE_BACKEND_API_URL` is non-default — matching `run.sh` (backend=base,
  frontend=base+1). The backend `ALLOWED_ORIGINS` must include the frontend origin.
- **Injected env vars override `.env` (important).** Node `dotenv.config()` and
  Python `load_dotenv(override=False)` never override an already-set variable, so
  anything injected by the Cloud environment/Secrets wins over `.env`.
  `TEMPORAL_TASK_QUEUE` is injected pointing at a shared queue — always `export
TEMPORAL_TASK_QUEUE=navi-agent-tasks-<unique>` for BOTH backend and worker so a
  local worker never consumes other runs' workflows (mirrors `run.sh`'s
  per-workspace queue). `BROWSER_PROVIDER` must be `kernel`, `steel`, or
  `browser-use` (which requires `BROWSER_USE_API_KEY` and
  `BROWSER_AGENT_BROWSER_USE_ENABLED=true` on the backend). The rollout flag
  defaults off and prevents new Browser Use sessions, challenge recovery, and
  proxy hopping into Browser Use; set it false to route new work to Kernel even
  if Browser Use was configured as the default provider.
  Browser Use Cloud has not passed the live WebAuthn assertion test
  (`browser-passkey-provider`); keep the flag off for passkey-dependent work
  until that provider passes. Its CAPTCHA solver also left a live reCAPTCHA
  image grid unresolved; hand unresolved challenges to the live-view user.
  When something is misconfigured despite a correct `.env`, check for an
  injected env var of the same name first.
- **Local backend tests on Fly hosts:** launch the test child with
  `env -u FLY_APP_NAME` before TypeScript imports. Any defined value, including an
  empty string, selects production mode and suppresses the local LLM dumps that
  the Rose and stream-contract blackboxes verify. Preserve the parent controller
  environment and fleet runtime identity. The existing capture assertions remain
  mandatory; a focused green replay does not replace complete coverage.
- **ngrok (public tunnels / AgentCard):** Cursor Secrets must include both
  `NGROK_AUTHTOKEN` and `NGROK_API_KEY`. `NGROK_API_KEY` is the **secret token**
  (`FIRSTPART_SECONDPART` from dashboard.ngrok.com/api-keys → Reveal), **not** the
  key ID (`ak_…`). An ID fails reserved-domain calls (`ERR_NGROK_208` / 403) and
  tears down `scripts/run.sh`. `cloud-init.sh` syncs both into `agents/.env` +
  `back-end/.env` and configures the local ngrok authtoken. Prefer
  `HOME=/home/ubuntu` so ngrok finds `~/.config/ngrok/ngrok.yml`. On Cloud VMs
  where Docker overlay mounts fail, set `ROSE_USE_SYSTEM_PG=true`.
- **Tests needing funded/live accounts** (RCA Step 4: third-party/config — surface,
  don't mask): the Codex E2B backend blackbox domain and all **smoke benchmarks**
  need OpenAI account credits (+ OpenRouter access to the `rose-1-ultra` waterfall
  models); `admin-health` needs Amplitude + admin-Stripe creds; `agentcard` needs
  `AGENTCARD_PUBLIC_URL`.
  The agents `benchmark` blackbox domain also contains real Blue Bottle LLM
  judge replays. Full agents coverage needs the complete authoritative env and
  working outbound access; HTTP capture does not replace live responses with
  mocks. Its existing runner control checks two bounded native lanes, ordered
  result reporting, cancellation drain, and exited-parent descendant cleanup.
  The terminal-evidence fixtures share one 60-second deadline across two isolated
  pytest groups; do not raise that limit or omit targets to mask serial waits.
  On Andy's Mac, run that full suite natively when an isolated Linux
  container lacks those prerequisites, and retain Linux checks for the cloud
  controller and affected platform-specific regressions. In particular, run
  `bash scripts/tests/cloudbench-multi-workstream.test.sh` on Linux at the
  reviewed source: its fake guest executes the real Linux worker subreaper.
  Darwin rejection tests do not substitute for that mandatory lifecycle gate.
  Its permanent `cloudbench-fake-volume-contract.test.py` runs the actual fake
  provider writers through real snapshot admission; keep positive volume sizes
  consistent with their Machine mounts before exercising ownership scenarios.
  Activate the agents venv and prepend the installed Node 22 bin directory when
  launching this gate through Machine exec; its default PATH can select Node 20,
  which cannot execute the hermetic TypeScript seed fixture.
  Keep Linux `TMPDIR`
  outside the checkout (for example `/var/tmp`): production archive guards
  intentionally redirect paths under the repository.

## Eval Suite

LIVE campaign acceptance, cloud startup reuse, cold-image builds, cached
diagnostics, strict cohorts and launch monitoring: invoke the `/benchmark` skill.


**`agents/benchmarks/tasks.json` is the ONE canonical benchmark catalog.** Benchmark tasks and migrated long-horizon evals live here; ordinary blackbox/vitest tests do not. Each entry carries the additive eval contract: `status`, `runner` (`agent`), `bench` (`pipeline-e2e` for Rose harness plumbing vs. `rose-bench` for harness-independent capability), `description`, `environment` (mode/db_fixtures/base_images/services/secrets/live_targets/context_notes), `evaluators[]` (`static_check` | `single_turn_llm_judge` | `agentic_llm_judge`), and `source` (provenance pointers). Validated by `agents/benchmarks/long_horizon.py:validate_catalog()`. Idea kernels that haven't become evals yet live in `agents/benchmarks/long_horizon_ideas.json`.

**Pre-Deploy bench selection (auto-attach):** `/deploy` does **not** run the full daily suite. `agents/benchmarks/select_predeploy_benches.py` builds a bounded set every deploy:

1. **Floor (existing smoke)** — every `smoke`-tagged harness task always runs (no history gate)
2. **History gate (added canaries only)** — floor canaries + path extras are eligible only when their **last 3 eligibility attempts** in `agents/benchmarks/history/task_attempts.jsonl` all passed; otherwise skipped (`SKIPPED (need last 3 historic passes)`). New/flaky canaries stay off `/deploy` until they earn that streak on the daily path. Predeploy / active-worktree runs set `counts_for_deploy_eligibility=false` so they cannot invalidate a canary after it is assigned.
3. **Floor canaries** — one history-qualified canary each for `payment`, `grep`, `sms`, `browser_stateful` (uncovered categories are reported)
4. **Path extras** — more category depth when the git diff touches matching paths (history-qualified only)
5. **Hard cap 20** — floor must always fit; extras truncate with a loud scream (`PREDEPLOY BENCH HARD CAP HIT`). The CLI clamps `--cap` / `PREDEPLOY_BENCH_CAP` values above 20; changing the ceiling requires a reviewed source change.

Preview selection with `cd agents && source venv/bin/activate && python
benchmarks/select_predeploy_benches.py --surface local --format report` (use
`--surface cloud` for cloud-compatible tasks). Repeat `--changed-file <path>` to
inspect a specific diff, or use `--changed-files-from <file>`. The selector keeps
the mandatory floor, deduplicates tasks, then adds history-qualified depth for
changed areas up to 20. Read its coverage gaps, history skips and dropped extras;
do not label tasks `smoke` or adjust their evaluators to force selection.

The 20-task selection cap is separate from execution concurrency. `bash scripts/run-predeploy-local` runs the selected tasks with concurrency 2 by default to avoid starving the shared local stack; `PREDEPLOY_LOCAL_CONCURRENCY` is an emergency/debug override. Use `--list` to preview names and `--history` for recorded timings. Cloud acceptance slices use their explicitly requested fleet width.

When adding a benchmark to `tasks.json`, auto-attach it to this algorithm:

- Set `deploy_category` to a known category (`payment`, `grep`, `sms`, `browser_stateful`, `browser`, `auth`, `plaid`, `phone`, `attachment`, `claude-code`, `research`, `response-schema`, `wait-for`, `chat`, `mass-agent`, `harness`) — or rely on matching tags (same names) for derivation
- Set `deploy_canary: true` if this task should be preferred as the one-per-category floor/path pick (otherwise shortest ready `pipeline-e2e` wins)
- Tag `smoke` **only** for must-run harness plumbing (always on the floor; counts toward the cap; no history gate)
- New category? Add it to `FLOOR_CATEGORIES` and/or `PATH_TRIGGERS` in `select_predeploy_benches.py` and to `KNOWN_DEPLOY_CATEGORIES`
- Never rename an existing task `name`
- Before benches run, the selector **always prints** `TOTAL SELECTED: N / 20` (and screams when the cap binds)

**The single full-suite entrypoint:** `scripts/run-bench eval` owns an isolated local stack and invokes `agents/benchmarks/run_eval_suite.py`. It runs every `status: "ready"` benchmark entry through `run_benchmark.py` and lists `status: "incomplete"` entries (missing fixtures/judges) as skipped. `scripts/run-bench eval --list` prints the holding set split by `rose-bench` vs. `pipeline-e2e`; `--bench rose-bench` or `--bench pipeline-e2e` runs one axis. The lower-level `run_eval_suite.py --port N` is for an explicitly reused running backend. Run the suite after every agent-harness change to evaluate whether progress is being made.

**The FE query box reads this same catalog** via `GET /api/benchmarks/test-prompts` (adapter in `back-end/src/domains/benchmarks/service.ts`); the dev test-prompts picker cannot drift from the suite.

**Every task runs on a base-image fixture.** Tasks that don't declare `environment.base_images` inherit the canonical `base:victoria-prod-sync-v1` artifact shared by local and cloud runners; declared environments with empty `base_images` inherit it too. That canonical base includes frozen WhatsApp history, while compute tokens are refreshed as a live overlay after restore. Registry + pg_dump freezer: `agents/benchmarks/fixtures.py` (`ensure_base_image_snapshot()`). Task-specific `db_fixtures` are deltas on top of the one canonical base image.

**Every completed run is recorded — pass or fail, local or prod.** `BenchmarkRun.save()` writes the full run record (message transcripts + logs) to `runs/*.json`, appends every attempt to the attempts ledger, and full LLM trajectories land in `.llm-dumps/<agent_id>/` (always-on locally; prod goes to ClickHouse).

**⛔ Never rename an existing task `name`.** The name is the primary key across all history stores; a rename orphans pass history and latency baselines:

- **Attempts ledger:** `agents/benchmarks/history/task_attempts.jsonl` — one line per _completed_ run (pass AND fail) with status, duration, cost, failure_reason. Written by `benchmarks/timeout_history.py:record_attempt()`. This is the run-stats record (attempt counts, failure rates).
- **Success ledger:** `agents/benchmarks/history/task_durations.jsonl` — one line per _passing_ run, keyed by `"task"`. Read via `benchmarks/timeout_history.py` (`summary()` → p50/p95, derived timeouts). Kept pass-only so failure durations can't poison timeout derivation.
- **p99/latency baselines:** `agents/benchmarks/history/span_durations.jsonl` — keyed by `"benchmark"` + `"span_key"`. Read via `benchmarks/span_history.py` / `agent_latency.py` (p50/p90/p95, regression flags).
- **Full run records:** `agents/benchmarks/runs/*.json` — per-run task results + merged logs, keyed by `TaskResult.name` (`run_benchmark.py --compare A B`).

One task name threads all three stores, so any eval is traceable end-to-end: definition (tasks.json) → pass history → latency profile → run record.

## World Model Harness (WMH) model cache

The native WMH model is built locally and cached, encrypted, in R2 so a fresh
devbox restores it instead of rebuilding for hours:
`python -m benchmarks.wmh_build_cache pull|push|status` (from `agents/`).
Rebuild and push only on user request. The full run procedure is the
`instantiate-whm` skill (`.claude/skills/instantiate-whm/SKILL.md`, section 6).

Cloud SIM guests serve the same native model by default (`WMH_ENGINE=experiential`,
`rose-archive`, `rose-wmh-gpt61`, `rose-outcome-distribution-v4`; set
`WMH_ENGINE=legacy` for the old model). Publish it to the fleet donor in three
steps: `bash scripts/run-bench-cloud --build-wmh` (builds natively on an owned,
ledgered big machine forked from the donor snapshot, pushes the
`rose-archive-serving` serving-only and `rose-archive-native` full caches, then
destroys the machine and volume) → `bash scripts/run-bench-cloud --refresh-wmh`
(restores that cache and the native venv on the donor volume, then snapshots it;
the 2 GB donor never builds). Then run
`scripts/run-bench <task> --sim-on <task>`. Each `--sim-on` guest is a `performance-8x`/64 GB machine: native serving holds
~30 GB and loads for ~10 minutes before the task starts. Guests fail clearly if the native
pointer or venv is missing; they never build or install at run time.

## Log Files

Check these when errors occur:

- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`
- **Mac App (console):** `mac-app/mac-app-console-logs.log`
- **Mac App (IPC):** `mac-app/mac-app-ipc-logs.log`
- **Docs:** `docs/docs-logs.log`

**Prod logs (for benchmark agents):** Benchmark runs auto-collect logs from retained ClickHouse rows and live service APIs into the result JSON (`agents/benchmarks/runs/*.json`):

- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **ClickHouse (retained Fly.io worker):** Agent execution logs from `observability.fly_logs`, retained 7 days — via `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` in `agents/.env`
- **Fly.io (live worker stream):** Live agent execution logs during benchmark runs — via `FLY_API_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.

## Debugging Slow Agents

Three diagnostic tools. Run **all three in parallel** whenever an agent is slow, stalled, or fails — they answer different questions. Then fully expand whichever one points at the smoking gun.

```bash
cd agents && source venv/bin/activate

# "Why was this slow/stalled?" — span-based cross-log waterfall + hot paths
python benchmarks/agent_latency.py <agent_id>
# Flags: -v (verbose/full tree), --speedscope OUT.json, --stall-threshold N,
#        --slow-threshold MS, --no-color

# "What errors happened where?" — event-timeline tree across worker/backend/messages
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
# Expand per-source: --source worker|backend|messages  (add --url <BASE> for prod)

# "How much did this cost / cache?" — tree-wide token + cache breakdown
python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>
# Cache metrics are tree-aggregated (root + all sub-agents via /api/tool-usage/tree/:id)
# Results stored in agents/benchmarks/runs/*.json

# "Where are cache hits/misses?" — file-tree view of prompt caching per LLM call
python benchmarks/agent_cache.py <agent_id>
# Flags: --all (all agents), --since 5m, --json, --log <path>
```

**`agent_latency.py`** reads `agents/navi-worker-log.txt` and `back-end/backend-logs.log`, builds a span tree from `span.start`/`span.end`/`db.query`/`broadcast.span` events (correlated by `span_id`/`parent_span_id`, falling back to `request_id` + time-window containment), and prints:

- Executive summary: re-run command, total duration, span count, error count.
- **Top 10 slowest paths**, **Slowest LLM Calls**, **Slowest Backend HTTP Requests**, **Errors** (deduped with counts).
- A hierarchical waterfall (`offset | dur | trace`) nesting sub-agents under their spawn call. Inline `IDLE` markers for gaps above `--stall-threshold`.
- `-v` expands every span (DB, broadcasts, HTTP internals).

**`agent_logs.py`** dumps the cross-source event timeline (including prod via Render, ClickHouse, and Fly APIs with `--url`), grouped into a tree with errors highlighted. Best for reading the exact error message + stack + surrounding context after `agent_latency.py` points at a layer.

For retained Fly.io worker logs, query ClickHouse directly:

```bash
cd agents && source .env
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"
```

**`agent_cache.py`** reads `agents/navi-worker-log.txt` for `llm.cache` events and renders a tree of cache read/write/hit% per LLM call, grouped by agent. Shows every call site (plan_loop, planner, verifier, explore, execute, chat) with its model, whether it used claudeAuth (direct Anthropic = $0) or waterfall, and per-call cache metrics. Use `--all --since 5m` for a cross-agent overview after running benchmarks.

Typical signatures to look for: `peer closed connection` during streaming, `[NO END]` on an LLM call (crashed/cutoff mid-stream), `Failed to fetch pricing` retries (underlying-model 404s burning 30s each), P2024 Prisma pool timeouts (5s × 3 retry on `db.findFirst`), 429 from Anthropic on the `claude_token` path (rate-limit fallback to waterfall), `thinking.adaptive.effort: Extra inputs` (effort must go in `output_config`, not `thinking`), 0% cache hit on claudeAuth (check `cache.prefix_fingerprint` hashes match across calls — differing hashes = different prefix = no cache reuse).

## Deploy command regression scheduling

New tests must pass five consecutive runs with unchanged test code before being finalized, to catch flaky behavior.

`python3 scripts/run-deploy-structural-gates.py` runs the complete deploy
command registry with eight concurrent suites by default. Use `--max-workers N`
for a different host limit; this never changes benchmark fleet width. Fixture
startup/cleanup observations allow sixty seconds, and assert actual terminal
state, exact resource release, and real failures. Simulated review deadlines
use a controlled clock so host load cannot change the scenario.
Activate `agents/venv` before invoking the runner, and keep its `bin` before
Homebrew in `PATH`; otherwise child `python3` commands select a different
interpreter without the declared agent dependencies.
For the sandbox gate, inspect the retained test-run `summary.json` and
`claude-code.log` for the real smoke result; the outer command prints an aggregate.
A silent startup recurrence can use temporary `NODE_DEBUG=esm`, with all output
redirected to private `.context` artifacts. Keep those diagnostics out of git.
Semantic readiness checks session state and visible behavior; never add a
network-idle prerequisite to the realtime app's authenticated test helper.

### Worker generation verification

If `monitor-cooperative-cutover.ts --verify` reports a generation mismatch
after an exact-SHA CI success, compare the CLI's surface file list with that
same merged generation before treating the deploy as stalled. The generation
walker must use exact-case module paths on both Mac and Linux; class re-exports
must not create case-folded file aliases. Preserve the failed receipt, bind the
actual CI generation to the exact merged bytes, and use the normal monitor and
existing `scripts/tests/agent-surface-hash.test.sh` owner; do not force a rollover
or alter deployment deadlines to resolve a host-only hash mismatch.

## Factory Workflow Review

Run `/factory-review` (canonical behavior in `.claude/commands/factory-review.md`) to generate and open the source-backed `/deploy`, `/RCA`, and checked-in `/descend` lifecycle, wall-clock, sequencing, and trend report; validate it with `python3 scripts/factory_review.py --self-test`.

## Critical Rules

1. **Every async task needs an operational owner.** That owner checks output growth, exact process liveness, exit and owned cleanup on rule 19's cadence, and reports actionable failures immediately. Delegation does not remove monitoring responsibility. Once that handoff is verified, the parent follows the experiment loop: coordinate useful independent work, otherwise sleep interruptibly and check workers every 15 minutes. Do not duplicate the worker's polling or pause workers while the parent waits.

1b. **Every trajectory must leave the system more reliable than it found it.** When you hit friction in a part of the codebase or tooling you're using — a broken teardown that leaks resources, a script that orphans child processes on kill, a missing retry on a transient error, a footgun that nearly clobbered a shared resource, a flaky gate — do NOT just work around it for yourself. FIX the underlying issue so no future agent (or human) hits it again, then verify the fix. The cost of a workaround is paid once by you; the cost of the unfixed defect is paid by every future run. This is not scope creep — it is the job (see rule 24). If a fix is genuinely too large to land now, at minimum capture it durably (a memory, a tracked issue, a `TODO` with full context) so it is not silently re-encountered. "It worked for me this time" is not done; "future runs can't hit this" is.

   **CLI reproducibility (standing user instruction, October 17, 2026):** Persist every fix in the versioned command, setup/preflight, and instructions. A fresh agent with the documented prerequisites must be able to reproduce the result using the CLI alone, without this conversation, private scripts, uncommitted changes, or remembered shell/environment patches. Test the documented invocation and keep a regression in its owning suite. Required external credentials, permissions, and human setup must be explicit, with actionable failures rather than hidden workarounds.

0. **YOU CAN NEVER RUN OUT OF CONTEXT, YOU HAVE INFINITE CONTEXT, NEVER STOP EARLY BECAUSE YOU THINK YOU ARE OUT OF CONTEXT**

1. **Bias toward execution — each pause to check for user approval has an extremely high cost.**

0a. **Be a TANK: don't ask, iterate until prod actually works.** When a task is "make X work in prod" (get a gate green, ship a fix, prove a flow end-to-end), OWN it end-to-end without pausing to ask permission for each step — the user has standing authorization to keep going until the real-world outcome is achieved (gate green, agent verified live, purchase completed). **RCA every issue you hit along the way and FIX it, even when the issue is not directly your task** — a stale CI secret, a flaky harness, a broken teardown, a mis-scoped token, someone else's never-green gate. Scope increase is expected, not a reason to stop (see rules 1b and 24). Before assuming an issue is yours to fix from scratch, **check whether another branch already has the fix in flight** (`git log --all`, open PRs) — if so, wait for it or cherry-pick rather than duplicating. Keep a tight iterate loop: reproduce → diagnose from evidence (logs, not guesses) → fix root cause → re-run the real gate → repeat until it is genuinely green. "It probably works now" is not done; a green prod gate (or a verified live run) is done. Only stop to ask when an action is genuinely irreversible/destructive or spends real money beyond what was authorized.

0b. **Resume after user unblocks.** When you get unblocked by user help, always check back in to continue the task you were unblocked from, which is often a /goal or goal to finish a process.

1. **Functionality is not complete until a test cements it in the `/deploy` path.** A feature, fix, or behavior change is unfinished if the only proof is a local demo, a one-off script, or a reviewer's eyeballs. Anything not explicitly tested is prone to regressions — and under agentic coding those regressions are EXTREMELY likely. The app is only as good as the suite that `/deploy` (or an equivalent recurring gate: blackbox, pre-deploy, daily) actually runs.

   Designing the test and its validation criteria is the main bulk of the work, not an afterthought after the implementation. Write the assertion first: what observable behavior must stay true, which suite owns it, and how `/deploy` will catch a silent break. Implementation is the smaller remainder.

   Functionality is only guaranteed if a test measures it and that test is cemented in a consistently-run path. Any behavior that lacks a cemented test is assumed broken until proven otherwise, and any bug we fix per RCA MUST land its reproduction test in the deploy process so the regression can never silently return.

   Every quick regression must run through the normal `/deploy` gates. Verify
   its registration and execution; a test file alone is not coverage. Extend
   the existing owning suite instead of adding a separate verification system.
   Adding larger tests or verification suites requires human approval.
   Native process-observation timeouts are read failures, not proof of a leak
   or absence. Keep bounded re-observation inside the existing owning gate;
   require positive parent/group/state evidence before cleanup. Teardown
   fixtures must include the runner's early EXIT-trap setup, and distinguish
   an executing child from an unreaped terminal child while joining their owners.
   Correlate timing diagnostics to the measured operation: a router-stream clock
   does not include later database or Temporal completion. Warn on inner elapsed
   observations; retain outcome, ownership and end-to-end completion checks.

2. **TDD loop** - Don't return until tests pass:

   ```
   while tests_failing:
       fix_errors()
       run_tests()
   ```

   When fixing a new issue that is not illuminated by a failing test:
   1. Diagnose the issue
   2. Create a test that reproduces the issue
   3. Fix the issue until the test passes
   4. Cement that test in a consistently-run suite (per rule 1) so the fix is permanent

3. **API changes require tests** - Add to `back-end/src/tests/blackbox/<domain>.blackbox.ts`

4. **No .md files** - Never create markdown docs unless explicitly requested

5. **Zod schema changes require approval** - Propose changes before implementing

6. **Follow RCA methodology for every bug** - Invoke `/RCA` (or read `docs/root-cause-analysis.md`) and follow the steps exactly. Never skip the evidence-gathering step (Step 0), never fix a symptom without tracing the critical path, never rationalize a failure as "pre-existing". **HARD GATE: never report a root cause without a LOCAL REPRO you ran and watched fail, plus a fix that makes that same repro pass. A theory ("probably load/a race/a 404") is not a deliverable — reproduce it or classify it as an open observability gap. For a benchmark failure, proxy tests do not prove the outcome: the exact unchanged task must also fail locally on the buggy revision and pass locally on the fixed revision via `scripts/run-bench --local <task>`.**

   For an RCA delegated by `/descend`, follow that command's staged parent-owned
   approval and default cloud outcome-proof contract. A local causal fail/pass
   pair permits a concrete candidate packet labelled Causal proof; outcome
   pending. The original failed benchmark and exact unchanged post-approval
   cloud member reruns supply outcome proof; no fix is Complete without it.
   Workers return approvals to main, infra repair is autonomous, and only the
   confirmed infra-failed scheduled jobs >=5% of the original scheduled total
   stops that exact owned run immediately (30 of 600). Ordinary
   task failures, other open RCAs and pending independent approvals do not add
   global gates.

7. **Search before implementing** - When adding new features, first search the codebase for similar patterns (e.g., when adding a new tool, study existing tools)

8. **No fallbacks during development** - When testing a new integration, don't add fallback paths; they obscure whether the primary path actually works

9. **Frontend state diagrams required** - All frontend components must have a state machine diagram as a comment at the top of the file; reference and keep this diagram up to date when modifying state flow

10. **Feature changes require diagrams** - When implementing any feature, include a diagram showing how the change fits into the system context before writing code.

11. **Pauses are user-initiated, not fixes** - When debugging, NEVER assume a pause caused a bug/crash. The user sends a pause AFTER noticing something wrong. Pauses are the symptom reporter, not the cause.

12. **Short timeouts, check logs** - Never set bash timeouts longer than 5 minutes; use short timeouts and check task output periodically to ensure long-running tasks complete smoothly.

13. **Do NOT over-truncate** - Never aggressively truncate content, especially important context flows. Truncate SPARINGLY and only when necessary to fit content inside a frontend component (e.g., chip/bubble UI with limited space). When in doubt, keep the full content.

14. **Sync Conductor workspace name on branch change** - Whenever you switch or create a branch, update the Conductor workspace display name to match — **but only if it's not locked**:

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = '$(git branch --show-current)' WHERE directory_name = '$(basename \"$PWD\")' AND pr_title_locked = 0"
```

To manually rename and lock (prevents auto-sync from overwriting):

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = 'My Custom Name', pr_title_locked = 1 WHERE directory_name = '$(basename \"$PWD\")'"
```

15. **Plans must have automated verification** - Every plan's verification section must describe automated tests, not manual steps. Designing those tests and their validation criteria is the main bulk of the plan, not a short appendix. If no existing test route covers the change, create one. If you need API keys, configs, or other resources to test, ask for them in the plan. The goal: once a plan is approved, bring the feature all the way through to PR merged into main using `/deploy`.

16. **ALL test failures must be fixed — no exceptions** - Never rationalize test failures as "pre-existing", "not related to my changes", or "infrastructure issues." This applies to EVERY test tier: Prettier, ESLint, TypeScript, structural tests, coverage, blackbox tests, AND smoke benchmarks. If a test fails, you MUST fix it before proceeding. Do NOT skip, do NOT rationalize, do NOT merge with known failures. If smoke benchmarks fail due to expired tokens, fix the tokens. If they fail due to Temporal issues, fix Temporal. If they fail due to slow LLM responses, investigate and fix timeouts. "Infrastructure issue" is a diagnosis, not an excuse to skip. The local DB (Docker Postgres) must be running for blackbox tests — `run-blackbox-tests.sh` auto-detects the container via `CONDUCTOR_PORT`/`CONDUCTOR_WORKSPACE_NAME`. If the container isn't running, start it: `docker start victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}`.

17. **Bug diagnosis guidelines** - When diagnosing issues found while running any tests, follow `docs/root-cause-analysis.md` exactly. Gather evidence first, trace the critical path, classify the failure, and complete Step 5's hypothesis fields (including the generalizable Problem class) before writing any fix.

18. **Validate via blackbox tests, not hand-rolled scripts** - When validating credentials, tokens, integrations, or any pipeline behavior, run the existing blackbox test (e.g. `testSmoke_claudeCodeAnswersQuestion` in `back-end/src/tests/blackbox/claude-code.blackbox.ts`) — NEVER write ad-hoc curl/python scripts to hit Anthropic/Supabase/etc. directly. The blackbox exercises the FULL path (DB read → decryption → E2B sandbox → Claude Code CLI → Anthropic) the way production does; a raw curl only tests one hop and misses layer-specific bugs. If no blackbox covers the case, extend the existing suite first, then run it.

19. **Background-task monitoring cadence** - The operational owner of a long-running background task (smoke suites, benchmark runs, `run.sh`, any `run_in_background=true` bash, or a raw `&` shell job) monitors it on this schedule:
    - **First 60 seconds:** poll every **10 seconds**. Catches silent early deaths (0-byte log, missing env, queue mismatch, PID died at startup). Check both log growth AND `ps -p <pid>` — a dead PID with no output means the task never started.
    - **After 60 seconds:** poll every **60 seconds**. The early-death window is over; longer intervals save context and tokens.
    - **Exit the moment the task finishes.** The instant you see the completion signal (exit code, "RESULTS: N/N passed", PID gone, "DONE" line), stop polling and move on. Do NOT sleep out the remaining interval. Do NOT keep polling after completion "to be safe."
    - This applies to operational monitoring everywhere, not just in `/deploy`. A coordinating parent with a verified monitoring handoff uses the fixed 15-minute worker check-in instead; it does not duplicate this polling. More specific live campaign and safety-monitor cadences still apply to their operational owners.

20. **Temporal activities must be idempotent** - Temporal activities are at-least-once. Any activity can run, complete its external side effect, and then fail to report completion back to Temporal because the worker-to-Temporal completion RPC was canceled, disconnected, or otherwise not recorded. Temporal will then retry the activity after the attempt timeout. Therefore every activity that writes to the backend, calls an external service, creates files, sends messages, charges money, or performs any other side effect MUST be safe to run more than once. Before performing a side effect, check whether the intended result already exists and return it when possible; otherwise use an idempotency key/deduplication record so retries do not duplicate work. Never assume "the activity returned locally" means Temporal recorded completion.

21. **Never `git stash`** - The stash ref is shared across all worktrees in this repo; popping can pull another workspace's in-flight work. Instead: `git diff HEAD > .git-wip.patch && git checkout -- .`, then `git apply .git-wip.patch && rm .git-wip.patch` to restore.

22. **Never disable linters** - Do NOT add `eslint-disable`, `// eslint-disable-next-line`, `/* eslint-disable */`, `// @ts-ignore`, `// @ts-expect-error`, `# noqa`, `# type: ignore`, `# pylint: disable`, `ruff: noqa`, or any equivalent escape hatch to silence a rule. Fix the underlying issue. Existing disables in the codebase should be removed when you touch the file.

23. **New user data providers** - When integrating a new user data provider, first model it as a normalized, grep-searchable document source with explicit sync state, source metadata, snapshot revision semantics, prod-path tests, and a prod-data benchmark before adding bespoke provider behavior.

24. **Clean up tech debt as you discover it — scope increase is expected** - When a file under edit has pre-existing lint errors, type errors, test failures, dead code, or other debt, fix it in the same PR. Do NOT rationalize "pre-existing" or "out of scope" to leave it. Scope increase beyond the narrow task is not only allowed but anticipated — bundle the cleanup with the change that exposed it. **Any error surfaced by a failing test, lint, typecheck, coverage check, or other gate is automatically in scope — even in files you did not touch.** If the deploy pipeline (or any required check) reports the error, fix it; do not skip it as "not my file" or "not my change."

25. **No benchmark reward hacking** - Never change benchmark task definitions, prompts, expected tools, pass criteria, load sizes, timeouts, concurrency limits, or production behavior just to make a benchmark pass. Do not raise a benchmark/tool timeout as a workaround for a timeout failure. First prove why it timed out with diagnostics: resource contention, memory growth, blocked external tool/session, retry loop, verifier/schema issue, slow database/API calls, or an unintended parameter/config change. Then reduce the underlying resource use, remove the stall, or fix the broken flow. Get explicit approval before changing any benchmark definition or timeout. General reliability rule: any Temporal activity wrapper that calls an LLM must allow at least 60 seconds; sub-60-second verifier/LLM activity timeouts are product bugs, not benchmark tuning.

25a. **Never add runtime nudges to the harness** — synthetic user/tool messages injected into the planning LLM's trajectory (network monitors that fabricate tool failures, supervisor recovery nudges, skip-recovery guards, OTP/handoff autofill, classifier recovery constraints wired into message assembly, etc.) are almost always overfitting. Let the model act on real tool results. Deploy Step 0c requires human approval if you touch harness trajectory-injection sites.

25b. **Avoid string-matching classifiers in our harness** — that is an ANTI-PATTERN.

26. **Prompt approval is snapshot-scoped** - Human approval for prompt, instruction, command, skill, or prompt-related changes applies only to the diff that existed when approval was requested. If any later fix or test iteration adds or changes prompt-related files, stop and request fresh approval for those additional hunks before running deploy with the prompt approval flag. Never treat "prompt changes approved" as blanket permission for future prompt edits.

27. **DO NOT KILL OTHER RUN-BENCH TASKS. EVER.** - Cloud benchmark controllers (`run-bench-fleet`, `run-bench-cloud`, `run-bench-hub-poller`) and their children may belong to OTHER workspaces/sessions sharing this machine. Broad kills (`pkill -f run-bench`, `pkill -f flyctl`, `pkill -f benchmark`, killing by port scans, etc.) have repeatedly murdered healthy 28-machine fleets mid-run from the outside. Rules: (a) NEVER pkill by a pattern that could match a benchmark process you did not launch in THIS session; (b) to stop YOUR OWN run, TERM exactly its controller PID (printed at launch; also in its detached log path / run dir) and let its cleanup traps reap machines/volumes — never kill children directly; (c) if a run you don't own looks stuck or abandoned, surface it to the user — killing it is the user's call, not yours. Controllers announce received signals (`⚰️ controller received TERM`) — check the victim's detached log before assuming an infra failure.

28. **Every change must hold at 10k agents** - The design target is 10,000 concurrent agents. Before shipping ANY change, ask "what happens to this at 10k agents?" and reject designs that degrade with agent count. Concretely: no per-user/per-root fan-in that funnels many agents' traffic through one channel, connection, subscription, row, lock, or in-memory structure (e.g. broadcasting every agent's realtime stream onto a shared `user:<userId>` topic is a firehose that melts at scale — keep per-agent isolation like `agent:<id>`); no unbounded per-agent polling, N+1 queries, full-table scans, or O(agents) work on a hot path; no shared mutable state, global counter, or single-writer bottleneck that every agent contends on; no realtime/broadcast/DB pattern whose cost grows with the number of agents a user or tree owns rather than with the one agent being acted on. Prefer per-agent isolation, bounded/backpressured work, sharded/keyed resources, and derive-don't-accumulate. A fix that resolves a 1-agent symptom but scales O(agents) is not a fix — state the 10k-agent behavior of your change (channels opened, subscriptions held, rows/queries per agent, bytes per broadcast, lock contention) in the RCA/PR before merging.

## Plans

All implementation plans live in `docs/plans/` (checked into the repo):

- `docs/plans/active/` — plans currently being implemented
- `docs/plans/completed/` — plans that have been shipped

Plan filenames should be kept in sync with the description of the task (kebab-case, e.g., `context-pointers.md`).

**Before modifying a file**, check `docs/plans/completed/` for plans that touched those files. Read them to understand implicit business functionality and ensure changes don't break it.

The `/deploy` skill automatically moves the related plan from `active/` to `completed/` before merging (if one exists).

## Temporal/Agent Patterns

- Workflows must be **deterministic** - no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** - safe on retry
- Activities may run on **any machine** — never rely on module-level shared state; add backend-API fallback (Claim Check pattern)
- Keep activity args small and serializable (IDs, names, flags) — resolve rich objects inside the activity; args accumulate across long workflows toward the 2MB payload limit
- Error handling: catch → format → yield error event → **don't raise**
- See `agents/tools/base.py` for ToolManager pattern

## Logging Guidelines

Always log these events (use `[Component]` prefix, include IDs, truncate payloads to 200 chars):

1. **HTTP requests** - method, path, body, response status, duration
2. **External calls** - Temporal, LLM, third-party APIs (request + response)
3. **Workflow events** - phase transitions, signals, completion/failure
4. **Tool execution** - tool name, input summary, output summary, duration
5. **DB mutations** - table, operation, record ID
6. **Errors** - message, stack, context (agentId, userId)

## Test Credentials (Dev)

- Supabase URL: `https://kzlurqihzaolhzsbkctf.supabase.co`
- Test phone: `+19729777432`
- Test OTP: `181818`
- **Backend API key:** read `BACKEND_API_KEY` from the authoritative `agents/.env` and `back-end/.env` files; preserve their matching value.
- If a test fails due to an invalid GPT auth token or invalid Claude auth token, retry with the token stored locally on the computer, or refetch the ones stored in the prod database — do not escalate before trying these.

**Query backend locally:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" -H "X-API-Key: $BACKEND_API_KEY"
```

## Database

- **ORM:** Prisma
- **RLS:** Enabled on all tables - users only see their own data
- **Realtime:** All realtime events use explicit HTTP broadcasts to Supabase Realtime (`POST /realtime/v1/api/broadcast`). `createMessage()` auto-broadcasts INSERT events; `updateAgentStatus()` auto-broadcasts UPDATE events. No DB triggers are involved.
- **Schema changes MUST ship a migration** — do NOT rely on `db push`. Local dev/setup (`scripts/run.sh`, `scripts/setup-db.sh`) run `prisma db push --accept-data-loss`, which silently conjures the DB from `schema.prisma`, so blackbox/local tests pass even with NO migration. Prod (`render.yaml`) runs `prisma migrate deploy`, which ONLY applies committed migration directories. A schema edit without a migration therefore works locally and **500s in prod** ("table/column does not exist" → e.g. every compute-token fetch fell to the paid waterfall on 2026-07-06). Correct path:
  1. Edit `back-end/prisma/schema.prisma`.
  2. Author the migration WITHOUT `prisma migrate dev` — its shadow DB replays the whole history including the squashed baseline (`00000000000000_init`), which contains Supabase RLS policies (`auth.uid()`) + `realtime.*` triggers that don't exist on a plain local Postgres shadow, so `migrate dev` fails. Instead diff your edited schema against the current local DB (no shadow). `back-end/.env` points BOTH `DATABASE_URL` and `DIRECT_URL` at PROD, so name the local database explicitly (`LOCAL=postgresql://postgres:postgres@localhost:5432/<local db>`; `victoria` on Cloud system Postgres):
     `mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<desc> && npx prisma migrate diff --from-url "$LOCAL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<that-dir>/migration.sql`
     (run BEFORE the push, while the local DB still reflects the old schema). Review the SQL, then apply it locally with `DATABASE_URL="$LOCAL" DIRECT_URL="$LOCAL" npm run prisma:push:local`, which refuses any non-localhost target. Never run `prisma db push` directly from `back-end/`: it writes PROD and silently drops every index Prisma cannot model (trigram, partial, expression), as in `docs/rca/cases/2026-06-27-stray-db-push-from-another-worktree-dropped-a-prod-column.md`. A loose `.sql` in the migrations root is IGNORED by `migrate deploy` — it MUST be `<timestamp>_<name>/migration.sql`.
  3. Commit the migration directory with the schema change. `src/tests/structural/migration-drift.test.ts` fails the build if `schema.prisma` has a model/column with no migration (both directions).
- **Migration history is a single squashed baseline** (`00000000000000_init`, from a `pg_dump` of prod on 2026-07-06 via `back-end/scripts/clean-baseline-dump.py`). It reproduces prod exactly — tables, enums, indexes (incl. the `pg_trgm` expression index), functions, triggers, and RLS policies — and existing DBs have it `migrate resolve --applied`. To re-baseline after major drift, re-run that script on a fresh `pg_dump` and re-resolve.
- **Query DB:** `npx tsx back-end/scripts/query-db.ts` (modify script as needed)

## Supabase Realtime Messages

All realtime and tool message types are defined in `front-end/src/lib/realtime-types.ts`.

## Rose Completions

In-process model racing (claudeAuth → OpenRouter waterfall). No external HTTP hop.

**Scripts and experiments that fire LLM requests reuse Rose.complete.** Replays,
model A/Bs, judges and one-off probes go through the same client production uses,
never hand-rolled provider HTTP or a raw API key:

- **Python:** lease a token with `helpers.llm.fetch_compute_token_activity(user_id, token_type=...)`.
  Build auth with `_build_compute_auth_context(...)`. Then call
  `providers.rose.RoseClient().complete(...)` or `.collect(...)` with `pool=`,
  `claude_auth=`/`gpt_auth=` and a `call_site`. Release the lease afterwards.
- **TypeScript:** call `createStreamingCompletion` (`back-end/src/providers/rose`).
  Pass a token from `fetchComputeTokenForUser(userId, { tokenType })`.

Pick the model by pool and token type:

| Pool | Claude lease | GPT lease | No token |
| --- | --- | --- | --- |
| `rose-1-ultra` | Opus | GPT-6 Sol | API-key/waterfall legs |
| `rose-1-flash` | — | — | Cerebras Qwen then its waterfall |

An exhausted or missing local `GPT_API_KEY`/`ANTHROPIC_API_KEY` is not a blocker.
Leased compute tokens are the supported path. Record the served `actual_model` and
`pool_name` for every call: a fall-through to another model invalidates a model
comparison.

Python waterfall TTFT/progress guards belong inside each configured leg. Before
productive output, a stalled leg may use the existing next model; partial-output
idle errors and the fixed whole-call deadline remain terminal. Do not raise the
590/90/120 browser budgets to hide this distinction. Run the normal deploy-owned
`cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py rose rose-browser-use llm`
for client or waterfall edits. These suites include fallback, original deadline,
parser progress, cancellation and response-closure controls. Browser collect
failures retain their built inputs and requested configuration through the
existing best-effort dump path, with the same request/span/root and cache
bindings. Capture failure preserves the original exception; cancellation and
successful browser dumps are unchanged. Older failed calls may still lack an
exact input dump; earlier successful dumps are not substitutes.
See `docs/rca/cases/2026-10-06-client-stream-guard-bypassed-waterfall-fallback.md`.

- `back-end/src/providers/rose/` - TS client (chat path: router/generator/supervisor)
- `agents/providers/rose/` - Python client (agent/browser-use path)
- `back-end/src/providers/rose/pools.ts` / `agents/providers/rose/pools.py` - Canonical pool registry (`rose-1-flash`, `rose-1-ultra`, `rose-1-browser-use`)
- `back-end/src/routes/agents.ts` - Agents API (create, poll, pause/resume)
- `back-end/src/providers/hybridAuth.ts` - API key authentication. There is NO
  `src/middleware/` directory — both auth middlewares (`auth.ts`, `hybridAuth.ts`)
  live in `src/providers/`. Grepping the old path silently returns nothing, which
  is how a whole authentication path was missed during an RCA.

## Planner Memory (trajectory RAG over finalized runs)

`call_planner_llm_activity` retrieves compressed memories of past runs with similar goals and forks a native
`get_memories` tool call + tool result onto the END of the planner context (never into the system prompt), so the
cached prefix (tools + static system prompt + conversation) is byte-identical with or without hits. Per-agent
`memory_enabled` (create body / `Agent.memoryEnabled`, sub-agents inherit) gates it; benchmarks default it off.
Code: `agents/providers/planner_memory/`, backend `src/domains/planner-memory/` + `src/providers/plannerMemoryStore.ts`.

- **History table = the RAG corpus.** `PlannerMemory` gets one row per finalized root bundle, written in the same
  archive finalize that publishes the R2 manifest (`traceArchiveLifecycle.finalizeAgentOnce`), so table and archive
  never drift (cemented by `back-end/src/tests/blackbox/planner-memory.blackbox.ts`). `criticalPath` is a TTL-free
  cache: the first planner that retrieves an uncompressed row reads the bundle, runs the compressor once (`compressor.py`,
  prompt capped at 100 lines by test), and PATCHes it back. No cron, no index build.
- **Retrieval:** one indexed Postgres query (`to_tsvector` GIN + `pg_trgm`) → in-process scoring (`retrieval.py`,
  `RetrievalConfig` = strategy + absolute cutoff chosen by `agents/benchmarks/memory_retrieval_bench.py` on the frozen
  labels in `agents/benchmarks/fixtures/memory/retrieval-labels.json`). Returning 0 or 1 memories is normal.
- **Tool history is native:** the planner declares a constant declared-only toolset (plan-phase tools +
  `get_memories`, `planner_context_tools()`); structured output keeps `output_config`, `tool_choice` is `none`. The
  waterfall (no declarations) flattens the fork to text via `flatten_tool_history_to_text`. `build_planner_messages`
  keeps real assistant `tool_calls` / `role: tool` pairs (no `[TOOL]:` flattening).
- **Proof (real planner LLM calls):** `cd agents && python benchmarks/run_memory_scenarios.py --port N` runs
  `agents/benchmarks/memory_scenarios.json` (31 scenarios from archived runs + 2 negative controls, fit/held-out split)
  memory off vs on and writes `.context/memory-dashboard/index.html` with the exact injected context per scenario.
  Registered in `scripts/test.sh` (smoke tier) together with `benchmarks/run_memory_compressor_bench.py`, which runs the
  compressor on real completed transcripts (`memory_compressor_cases.json`: one per task + the largest runs, up to
  10k messages) with generic transcript-grounded assertions (tool names, URLs, no PII, bounds). Catalog A/B:
  `planner-memory-blue-bottle-off` / `-on` (`start_phase: plan`, `success_on_plan`, `plan_shape` static checks,
  `environment.memory_fixtures`). Backfill history rows after deploy: `python scripts/backfill_planner_memory.py --stats`
  then `--backend <prod url>`; only completed runs are ever retrieved or compressed.
- **Fixtures:** `python scripts/build_memory_fixture.py --name <n> --bundle-id <root_agent_id>...` compresses real
  bundles into `agents/benchmarks/fixtures/memory/<n>.json`; `run_benchmark.py` loads them into the local stack's
  history table (internal PUT) for `memory: "on"` tasks. Global kill switch: `PLANNER_MEMORY_ENABLED=0`.

## Production Logs (Render)

Fetch backend prod logs via Render API:

```bash
# Recent logs (last 50)
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=50&direction=backward" \
  | python3 -c "import sys,json; [print(l['message']) for l in json.load(sys.stdin)['logs']]"
```

Env vars are in `back-end/.env`:

- `RENDER_API_KEY` - Render API token
- `RENDER_SERVICE_ID` - `srv-d3jga77diees73cgrvk0`
- `RENDER_OWNER_ID` - `tea-csppgi56l47c73djvpig`

### Prod health / latency dashboard (golden signals)

**"Is the backend slow right now?"** → one call: `cd back-end && npx tsx scripts/prod-health.ts`. It pulls Render request logs for a window and prints the four golden signals in a single view: **latency** (per-endpoint p50/p90/p99/max, routes templatized so `/api/agents/<uuid>` aggregates), **traffic** (req counts), **errors** (4xx/5xx per route + total), and **saturation** (slowest Prisma ops + a `EMAXCONN`/max-connection banner and deploy/instance state). Each endpoint's p90 is diffed against a rolling historical baseline the script persists to `scripts/.prod-health-history.jsonl` (gitignored) and appends to on every run — so `▲ +180%` flags a real regression vs. normal.

```bash
npx tsx scripts/prod-health.ts               # last 30m vs history
npx tsx scripts/prod-health.ts --window 2h   # wider window
npx tsx scripts/prod-health.ts --top 30      # more routes
npx tsx scripts/prod-health.ts --json        # machine-readable (for scripting/alerts)
npx tsx scripts/prod-health.ts --history     # inspect the stored baseline
npx tsx scripts/prod-health.ts --no-record   # don't append this run to history
```

Reads `RENDER_*` from `back-end/.env`; backs off on Render's log-API 429s. Typical culprit for a p99 spike with a pool-saturation banner: a Render deploy cutover (old+new instance Prisma pools exceed the Supabase pooler client cap → queries queue to Prisma's ~30s pool-acquisition timeout → `EMAXCONN`). Guarded since 2026-07: `providers/database.ts` derives `connection_limit` from the pooler budget (`POOLER_MAX_CLIENT_CONN`, set to 1000 on Render for the XL compute tier; code default 400) minus the fast-cache pool (`FAST_CACHE_DB_POOL`), cemented by `src/tests/structural/db-pool-invariant.test.ts`. DB is Supabase XL (4 dedicated cores, 16GB, `max_connections=240`, Supavisor `pool_size=60`).

## Production Env Vars

**You (Claude) own env-key management:** when you mint or rotate a credential, store it in every correct location — the relevant local `.env`, the matching prod surface(s) below, AND the Codex-cloud `rose` environment — never leave a key only in chat.

- **Render backend:** read `cd back-end && npx tsx scripts/render-env.ts` (all keys, masked), `npx tsx scripts/render-env.ts KEY [KEY...]` (exact values), or `--json`. **Do NOT hand-roll `curl .../env-vars?limit=100`** — Render caps a page at 100 rows and returns a cursor on the last row, so a raw `limit=100` silently drops everything past the first page. The service is already at 117 vars; on 2026-08-05 that made `AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS` read as unset when it was present. A missing var and a truncated page are indistinguishable, so the script paginates and refuses to report a partial list as complete. Set: `cd back-end && source .env && curl -s -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/KEY" -d '{"value":"VALUE"}'`; MANDATORY: User Approval Needed to Write Env Vars.
- **Fly agents:** read `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets list -a navi-whisper-lux`; set `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets set KEY=VALUE -a navi-whisper-lux`; MANDATORY: User Approval Needed to Write Env Vars.
- **Vercel frontend:** read `cd front-end && vercel env ls production`; set `cd front-end && vercel env add KEY production`; MANDATORY: User Approval Needed to Write Env Vars.
- **Supabase functions:** read `cd agents && source .env && supabase secrets list --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; set `cd agents && source .env && supabase secrets set KEY=VALUE --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; MANDATORY: User Approval Needed to Write Env Vars.
- **Codex-cloud `rose` environment:** the cloud sandbox env that mirrors backend secrets. Every key set on Render must also be mirrored here (and vice-versa). Set via the Codex cloud environment settings UI. MANDATORY: User Approval Needed to Write Env Vars.
- **boxes.dev Template box:** whenever you set an env var, also set it in the project's managed env so the Template box and future devboxes get it: `printf %s "$VALUE" | dvb-onbox env set --file <agents/.env|back-end/.env> --name KEY --value-stdin` (needs the `edit-project-settings` permission).

## Autonomous Agent Testing

When testing agent features (new tools, explore agent, spawn_agent, etc.), follow this loop:

**1. Look up the real user ID:**

```bash
cd back-end && npx tsx scripts/dump-sms-context.ts  # userId for phone +19729777432
```

Real user ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30` (Andy Prevalsky)

**2. Create an agent:**

```bash
curl -s -X POST "http://localhost:3001/api/agents" \
  -H "X-API-Key: $BACKEND_API_KEY" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "...", "start_phase": "plan"}'
```

Use `"start_phase": "plan"` to bypass chat mode and go directly into the Temporal workflow (plan → execute).
Use `"start_phase": "execute"` to skip planning too. Omit `start_phase` for normal chat mode.

**3. Poll messages every 10 seconds via GET agent detail:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" \
  -H "X-API-Key: $BACKEND_API_KEY" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
```

Messages are in the response under `.messages[]`. Each message has `role`, `message`, and `metadata` (JSON with `toolName`, `toolStatus`, `title`, etc.).

**4. On ANY unexpected behavior, IMMEDIATELY follow this strict sequence (no exceptions):**

```
Step 1: DELETE the agent (stop bleeding tokens)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: $BACKEND_API_KEY" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"

Step 2: KILL the run script (stop all services)
   pkill -f worker.py; pkill -f "npx tsx watch"; pkill -f "npx vite"; pkill -f electron
   lsof -ti :3001 | xargs kill -9  # force-free the port if needed

Step 3: READ logs and DIAGNOSE
   - Read agents/navi-worker-log.txt for tracebacks/errors
   - Query DB if needed to get raw message data
   - Identify the ROOT CAUSE before writing any code

Step 4: FIX the root cause in code

Step 5: RESTART the run script (resets log files, picks up code changes)
   CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh
   Wait for "Worker started, waiting for tasks..." in the log

Step 6: Create a NEW agent and go back to step 3 (poll messages)
```

**CRITICAL: Do NOT skip steps or reorder them.** Especially:

- Do NOT continue polling a failed agent — delete it FIRST
- Do NOT make fixes without killing the run script FIRST (workers don't hot-reload)
- Do NOT restart the run script without reading logs FIRST (you'll just hit the same error)

**Key gotchas:**

- Temporal workers don't hot-reload — must kill and restart after code changes
- Old agents can't resume after code changes (Temporal nondeterminism error) — always create fresh
- The `run.sh` script sets `TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME` which overrides `back-end/.env`
- `spawn_agent.py` imports MUST be at module level (not lazy inside methods) because it runs inside Temporal's workflow sandbox. Lazy imports trigger `threading.Lock` errors.

## LLM Call Map

Every LLM call in the agent pipeline, ordered by execution flow.

### Agent Pipeline (agents/, runs inside Temporal)

| #   | Call Site                                                         | Model       | claudeAuth | Forces Ultra | Context Composition                                                                                                   | Est. Tokens |
| --- | ----------------------------------------------------------------- | ----------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| A1  | **Main Loop (PLAN)** `loop/run_agent.py` → `call_llm_activity`    | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 4 PLAN tool schemas (500t) + conversation + blueprints          | 3-20k       |
| A2  | **Planner LLM** `helpers/llm.py:call_planner_llm_activity`        | agent.model | YES        | no           | `build_planner_system_prompt` (3k) + user_context + conversation. **skip_cache=True**                                 | 5-15k       |
| A3  | **Verifier (PLAN)** `helpers/llm.py:check_progress`               | agent.model | YES        | no           | `build_verifier_prompt` (500t) + full conversation (USER+TOOL only, no SYSTEM/ASSISTANT)                              | 3-40k       |
| A4  | **Main Loop (EXECUTE)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 6 EXECUTE tool schemas (800t) + full conversation + DAG results | 5-80k       |
| A5  | **Verifier (EXECUTE)** `helpers/llm.py:check_progress`            | agent.model | YES        | no           | Same as A3 but with execute-phase conversation                                                                        | 5-80k       |

### Sub-Agent LLM Calls (spawned from EXECUTE phase)

| #   | Call Site                                                                             | Model        | claudeAuth | Forces Ultra | Context Composition                                                                                                                                                 | Est. Tokens |
| --- | ------------------------------------------------------------------------------------- | ------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| S1  | **Explore Agent** `tools/spawn_agent.py` → `run_agent`                                | rose-1-flash | **NO**     | no           | `EXPLORE_AGENT_SYSTEM_PROMPT` (300t) + **network_metadata (2k contacts, 5-15k t)** + local_data_summary + 4 tools (web_search, web_fetch, grep, attempt_completion) | 2-25k       |
| S2  | **Browser Agent** `tools/spawn_browser_agent_v3.py` → `call_llm_structured_streaming` | agent.model  | YES        | no           | `build_browser_system_prompt` (400t) + step history + screenshots (multimodal, heavy)                                                                               | 5-30k       |
| S3  | **Sub-Agent** spawns full workflow (A1-A5 repeat)                                     | parent.model | YES        | no           | Inherits parent user_context (gatable via context_gates) + own conversation                                                                                         | recursive   |

### Tool-Level LLM Calls (inside activities)

| #   | Call Site                                                   | Model               | claudeAuth | Forces Ultra | Context Composition                                                    | Est. Tokens     |
| --- | ----------------------------------------------------------- | ------------------- | ---------- | ------------ | ---------------------------------------------------------------------- | --------------- |
| T1  | **message_person** `tools/message_person.py` → `call_llm`   | agent.model         | **NO**     | no           | system prompt with conversation history + person thread + user message | 1-5k            |
| T2  | **Deep Research** `tools/deep_research.py` → Perplexity API | sonar-deep-research | N/A        | N/A          | system prompt + query (separate provider, separate billing)            | ~500 in, 8k out |

### claudeAuth Flow

- User's Claude OAuth token fetched at workflow start (`fetch_claude_max_token_activity`)
- Passed to Rose completions endpoint as `claude_token` param
- Rose routes directly to Anthropic API, skipping racing ($0 cost to Rose)
- Detected in response: `actual_model` ending with `-claude` suffix (e.g. `claude-sonnet-4-6-claude`)
- Refreshed before EXECUTE phase in case it expired during PLAN

### Context Gates per LLM Call

Each LLM call site, the context chunks it receives, and which `context_gates` key controls each chunk.

**Gate keys:** `user_profile`, `authenticated_sessions`, `integrations`, `recent_communications`, `network`, `custom_system_prompt`, `shared_files`

| LLM Call              | Context Chunk                                 | Gate Key                 | Est. Tokens | Notes                                           |
| --------------------- | --------------------------------------------- | ------------------------ | ----------- | ----------------------------------------------- |
| **A1/A4 Main Loop**   | user profile (name, phone, address)           | `user_profile`           | 50-100      | Via `get_user_context` → `build_system_prompt`  |
|                       | authenticated browser sessions                | `authenticated_sessions` | 20-50       |                                                 |
|                       | connected integrations (Gmail)                | `integrations`           | 20-30       |                                                 |
|                       | 200 recent messages (24h)                     | `recent_communications`  | 2-10k       | **Heaviest chunk**                              |
|                       | 2000 contacts network                         | `network`                | 5-15k       | **Heaviest chunk**                              |
|                       | custom system prompt                          | `custom_system_prompt`   | 0-500       | User personality injection                      |
|                       | file attachment resolution                    | `shared_files`           | variable    | Base64 images, text files                       |
|                       | system prompt (identity, phase, tools, rules) | _always on_              | 2-3k        | `build_system_prompt`                           |
|                       | conversation history                          | _always on_              | 1-50k       | Grows per iteration                             |
|                       | blueprints                                    | _always on_              | 0-2k        | Iteration 1 only                                |
| **A2 Planner**        | user_context (pre-gated)                      | _inherits parent gates_  | 0-15k       | Same gates as A1                                |
|                       | planner system prompt                         | _always on_              | 3k          | `build_planner_system_prompt`                   |
|                       | conversation history                          | _always on_              | 1-10k       |                                                 |
| **A3/A5 Verifier**    | verifier system prompt                        | _always on_              | 500         | `build_verifier_prompt`                         |
|                       | full conversation (USER+TOOL)                 | _always on_              | 3-80k       | No gates, no truncation                         |
| **S1 Explore**        | 500-contact network metadata                  | `network`                | 5-15k       | Via `fetch_full_network_metadata`               |
|                       | local message thread summary                  | `recent_communications`  | 0-2k        | Via `fetch_local_data_summary`                  |
|                       | explore system prompt                         | _always on_              | 300         | `EXPLORE_AGENT_SYSTEM_PROMPT`                   |
|                       | 4 tool schemas                                | _always on_              | 400         | web_search, web_fetch, grep, attempt_completion |
| **S2 Browser**        | browser system prompt                         | _always on_              | 400         | `build_browser_system_prompt`                   |
|                       | step history + screenshots                    | _always on_              | 5-30k       | No user context, no gates                       |
| **S3 Sub-Agent**      | _all chunks from A1_                          | _inherits parent gates_  | recursive   | Gates set by parent's `spawn_agent` call        |
| **T1 message_person** | cross-contact voice sample                    | `recent_communications`  | 1-5k        | `fetch_recent_messages_activity`                |
|                       | 1-on-1 thread with person                     | _always on_              | 0-3k        | Always needed for context                       |
|                       | Exa person enrichment                         | _always on_              | 0-1k        | Always needed for personalization               |
| **T2 Deep Research**  | system prompt + query                         | _always on_              | ~500        | Perplexity, separate billing                    |

### Remaining Waste (not gatable)

1. **A3/A5 Verifier** - Gets full conversation with no truncation. On long runs (20+ iterations) this balloons to 40-80k. Not yet gated.
2. **T1 message_person** - `call_llm` doesn't pass `claude_token`. Small per-call cost.
3. **Schema gen** (`setResponseSchema.ts`) - Forces Rose Ultra for a simple task. Rose Flash would suffice.

## CodeRabbit Review

`/deploy` owns CodeRabbit's bounded state machine: one automatic initial review,
one batched incremental review, and at most one verification review. Never
review every intermediate push or use `gh pr checks --watch`; use
`scripts/wait-for-code-review` for the exact immutable HEAD, batch all valid
findings before pushing, and require `deploy_review_cycle.py require-mergeable`
before merge. A fourth cycle blocks the deploy as review-unstable.

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.

## JEV progress and ETA research checkpoint — October 21, 2026

CURRENT DATA QUALITY OVERRIDE: user requires SUCCEEDED tasks, not merely
COMPLETED lifecycles. Audit found a 142-hour label whose terminal result was
"new code version deployed, retry this tool". The old 10k corpus/metrics are
quarantined historical evidence. Active dataset is now
`.context/progress-jev-xp/training-success-v2`: 7,002 train / 1,572 test prefixes,
1,509 successful traces; retained development validation is 164 prefixes.
Removed 106 traces: 11 deployment interruptions, 58 mismatched final receipts,
37 browser/explore tasks without positive success evidence. Do not relabel
unknowns as successes or remove a trace just because it ran a long time.
Positive final own-call verifier 100% evidence is mandatory. No browser/explore
currently meets the strict gate; report that coverage gap.

The 35×5 batch finished all 175 candidates in 41.74 minutes before cleanup;
its original winner was candidate-165 (joint ratio 0.990991). Its old scores
are not clean-data claims. The durable checkpoint was explicitly migrated,
preserving prompts, watermark, candidate history/numbering and split ownership,
filtering train/validation rows, and invalidating old selection metrics.
The existing prompt is carried forward, not declared the clean-data winner.
Acquisition, dataset verification and continuation now fail closed without
success evidence. See `success.py`, `clean.py`, `clean_checkpoint.py` and
`clean_scores.py` under scripts/jev_progress. Local migration receipt:
`.context/progress-jev-xp/training-success-v2/checkpoint.json`. Normal
`weekly.py run` restores the cleaned state; never reset/bootstrap.

The user subsequently authorized report-only per-iteration test evaluations.
All five frozen, validation-selected candidates have clean-cohort results in
`.context/progress-jev-xp/batch-35x5-clean-report/summary.json`. They use the
same 1,572 successful test prefixes / 164 validation prefixes; test results
never enter mutation or selection. Every progress update must include the
updated graph, one value per iteration for average progress and ETA errors.


Owner request: optimize BOTH progress and ETA in the same GEPA-style loop,
including how incoming data is formatted, and refresh weekly from production.
This is research; do not deploy prompts or change the sidebar automatically.
Implementation and reproducible commands: `scripts/jev_progress/README.txt`.
Offline gate: `python3 scripts/tests/jev-progress-core.test.py` (also registered
in deploy structural gates). Do not put credentials or production traces in Git.

Historical data: 8,000 training and 2,000 test prefixes from 1,615 completed
traces. Development uses 256 training and 500 validation prefixes, grouped by
root family AND normalized goal. Progress is fraction of actual issued tool
batches, not semantic completion. ETA is time to the final own completion-tool
receipt. Browser/explore histories lack reliable ETA labels. The historical
sample is not a random census of production; repeated prefixes are correlated.
Distribution audit: 125/179 held-out traces have two tool batches. Of 499
prefixes in the 50–60% histogram bin, 449 are exactly 50%, including 369 from
two-batch traces. One root family contributes 186 of those 449. These are
event-weighted counts, not time occupancy or semantic goal-completion levels.

Model: TypeSafe `jev-1.13.0`. Remaining-batch anchors: 0,1,2,3,5,8,13,21,34,55+;
expected remaining batches produce progress = observed/(observed+remaining).
ETA choices: every minute 1–59, every hour 1–23, every day 1–29, months 1–11
(30-day approximation), and 1 year. Minimum one minute means zero-time cases
cannot be represented exactly. Reflector: GPT-6.1-Sol, low reasoning. Objective:
equal-weight mean of baseline-normalized trace-macro progress MAE and ETA
mean absolute log1p-seconds error. Labels, bins and decoding remain frozen.

Text mutations plus six paired format ablations chose the optimized prompt
with a JSON-lines timeline, prefix-derived elapsed time and observed tool
counts. Compact first-2/latest-8 history saved tokens but hurt accuracy.
Final paired 2,000-case test (1,744 ETA labels): progress MAE 18.56→14.45pp;
within ±10pp 38.0%→52.25%; empirical 65% band ±22.12→±17.57pp; empirical 95%
band ±46.54→±48.52pp. These are coverage bands, NOT normal-distribution sigma.
ETA log error 2.0435→2.0741 (worse), median relative error 98.89%→98.40%, mean
absolute time error 18.18h→43.25h (outliers worse). No claim of ETA improvement.
Long waits remain badly underestimated, and some 15–104 minute jobs are called
one year. Some early prefixes are wrongly judged nearly finished. Do not use
the reported test to select further mutations; new data must judge them.

Durable restart: `agents/venv/bin/python scripts/jev_progress/weekly.py run`.
The encrypted research state, training corpus, champion and evaluation receipts
live under `jev-research/v1/` in the existing private R2 trace archive bucket;
fresh devboxes do not depend on this box's `.context` directory. Credentials
and required dependencies are listed in the README. The one-time bootstrap
already ran; NEVER rerun bootstrap or reset the watermark to improve scores.
Local detailed results: `.context/progress-jev-xp/optimization/test-report.json`.

Continuation is mandatory: restore the saved champion INCLUDING input format,
acquisition filters, joint scoring protocol, per-run search budget, Pareto
candidate pool, next mutation number, fixed validation IDs/groups, training
corpus, seen-family/goal exclusions and production watermark. Do not restart
from the generic seed, regenerate validation membership, or silently reset
settings. Re-score retained Pareto candidates on current development data;
historical scores are provenance, never fresh comparison scores. Protocol
mismatches fail closed and require explicit migration. `--iterations N` is an
explicit persisted budget change; omit it to continue the saved budget.

Latest continuation: ten new mutations (#12–#21), all evaluated on the same
500 validation cases, produced no new winner. Best new joint error was 8.55%
worse than the re-evaluated incoming champion. No >=5% late improvement below
the previous best followed the four-candidate plateau. Retain the champion;
next mutation is #22, with 27 candidate prompts in durable history. The saved
per-run budget and patience are now 10. No fresh eligible production examples
arrived in this short window, and the historical 2,000-case test was not rerun.
Local curve/report: `.context/jev-weekly/2026-10-21T024539.635435_0000/optimization/learning-curve.json`.
This is a prompt-search observation, not a proof about statistical double descent.

Isolated previous-prediction experiment: same frozen prompt and 500 validation
prefixes, with an earlier estimate available in 457. One-step conditioning
changed progress MAE 14.99→15.25pp and ETA log error 1.726→1.683; joint error
was 0.06% worse. Recursive sampled-prefix feedback gave 15.31pp / 1.688 and
0.17% worse joint error. Keep this feature off by default; it is not part of
the active 35-candidate × 5-round search. See scripts/jev_progress/previous_prediction.py.

Integration audit confirmed research is NOT wired into the live lifecycle,
database estimate fields, event payloads, or sidebar. Legacy Agent.progress
is not a JEV estimate. Evidence: `.context/jev-integration-audit/report.txt`.
The research DB helper now wraps queries in explicit BEGIN READ ONLY / ROLLBACK;
startup PGOPTIONS alone was not reliable through the production connection.

Isolated OpenRouter comparison (2026-10-21): pinned
deepseek/deepseek-v4.1-flash-1017, reasoning disabled, same frozen JEV-tuned
instructions and 500 validation prefixes (43 traces; 171 ETA labels).
All 500 valid: progress MAE JEV 14.99pp vs DeepSeek 18.46pp; within 10pp
44.4% vs 38.6%; ETA log error 1.726 vs 1.673; combined normalized error
1.0522 (DeepSeek 5.22% worse). ETA median relative error 102.55% vs 99.32%.
JEV had one 1-year ETA outlier, DeepSeek none; mean absolute ETA error was
51.47h vs 13.07m. These validation results are not a new held-out test or
a DeepSeek-tuned comparison. OpenRouter reported $0.52584 for all 500 cases;
median request latency 0.995s. Keep JEV as research incumbent. Reproduce with
scripts/jev_progress/general_model.py. Encrypted receipt:
jev-research/v1/objects/79300ede5bad8ebe3195cd648a1a97601557038cbc36552c59a1b2e4fd670f37.

Every weekly run durably freezes the incoming prompt before a read-only
production pull. Newly observed families with unseen normalized goals receive
a permanent random 80/20 training/sealed split. All prefixes of the sealed 20%
are evaluated with the frozen incoming prompt, recorded separately, and NEVER
passed to reflection, validation, or candidate selection. Train only afterwards;
the next week's unseen sample tests that candidate. Report sample sizes and
coverage, failures and empty cohorts explicitly. Keep receipts append-only and
advance state conditionally. This prevents test-driven selection under the
protocol; it is not a security boundary against deliberately editing the code.
Fresh collection currently covers verified completed persistent root/child
agents only; archived browser/explore reconstruction remains a coverage gap.
The historical development set retains those agent kinds. Do not pretend
missing traces or timestamps were evaluated.
