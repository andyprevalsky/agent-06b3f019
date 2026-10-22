# Background agents + agent-to-agent messages + tree feedback routing

## Review checkpoint — 2026-10-21 UTC

PR #1563 remains unmerged. The user requires review of the implementation plan
and validation criteria before heavy anti-regression benchmarks. Do not start
that campaign, resume an automatic deploy-to-merge loop, or treat previous
"finish" instructions as permission to cross this checkpoint.

This checkpoint is **NOT READY**. The latest local deploy smoke and offline
coverage gates pass, but they do not establish the held anti-regression
acceptance. Earlier deploy failures remain preserved for review.
No new product implementation was made during the initial handoff audit.

### Implementation scope to review

1. **Durable background execution:** reuse the existing spawn executors; EXECUTE
   defaults to background, PLAN remains foreground. Keep existing depth limits,
   without adding a thread cap. Preserve original tool results and append one
   terminal notification per run, including after retries and handoff.
2. **Addressing and messaging:** required task names establish hierarchical paths;
   resolve same-tree targets, enforce authorization and idempotency, bound unread
   mail and sender rate, and wake finished general-purpose/explore/browser/code
   agents with a new task. Preserve prior runs and reject wakes while stopping.
3. **Control flow:** ordinary user messages reach the root and the model chooses
   which subtree receives them. Break DAG execution back to the existing execute
   loop; preserve running background work and protected phone/approval operations.
   Every wait mode wakes correctly; kill means FAILED with an attributable reason.
4. **Model context and verification:** persist changed environment context, append
   uncached status/time, preserve cached prefixes, distinguish agent messages from
   user authority, and preserve tool/result pairing. Verify authored drafts without
   accepting unsupported factual claims or actions. Pending children do not bypass
   the verifier and do not cause automatic completion rejection.
5. **UI:** retain existing general-purpose/for-each spawn UI; use the query-box
   agent panel and existing tree data. Include schemas, sent/inbound messages,
   addressable finished tasks and readable wait/kill states. Completed notifications
   must not create the noisy extra trajectory UI the user rejected.
6. **Lifecycle and scale:** pause, cost limit, deletion, parent termination and
   generation handoff retain their contracts. Preserve activity progress across
   continuation; avoid duplicate calls and notifications. Inbox delivery uses
   existing step requests; tree reads are indexed/bounded; idle cutover checks are
   signalled. Phone-as-spawn and SMS tree parity remain explicitly deferred.

### Automated validation matrix before heavy benchmarks

| Contract | Required observable result | Existing owning gate |
| --- | --- | --- |
| Background spawn and completion | Immediate address; unchanged original result; exactly one notification per run; attachments retain task provenance | agents background-agents, handle-tool-event, realtime-monitor |
| Messaging and isolation | Correct path/recipient; no cross-tree disclosure; retry does not double-deliver; bounded unread/rate accounting | backend agents/data; agents agent-control |
| Finished-task wake | Same address, fresh inbox/run, old messages not replayed, new terminal result; no wake while killed/paused/finishing | agents agent-control/background-agents; backend agents; frontend background-agents |
| DAG and waits | User/agent input interrupts promptly; unrelated completion does not satisfy targeted wait; protected calls/approvals survive; timeout and original deadline retained | agents dag-executor, wait-for, wait-seconds, workflow |
| Context and verifier | Correct roles/pairing; cache prefix preserved; latest correction honored; authored text visible; unsupported claims rejected; schema errors yield recoverable feedback | agents llm, rose, prompts, prompt-invariants, run-agent, tool-schemas |
| Lifecycle | Pause/cost/delete/kill/parent-finish stop the correct subtree; no duplicate side effects; continuation and cutover preserve live work | agents workflow, generation-cutover, deploy-resume-e2e, background-agents; backend agents |
| UI | Existing spawn interactions preserved; panel counts/states/schemas and message routes correct; terminal labels and transcript notice position correct | frontend blackbox and semantic gates |
| Scale | Bounded query/row/payload counts; no per-step empty inbox GET or shared hot-row bottleneck; explicit 10k-agent resource accounting | backend query tests; agents context/inbox tests; reviewed query plans and load results |

Passing these checks requires source-bound receipts, not test-file existence.
Run affected regressions first, then applicable lint, typecheck, structural,
coverage and integration gates. New regressions must be discovered by the
existing runners. Each discovered defect needs a failing owning-boundary repro,
the same passing repro after its fix, and the exact unchanged benchmark outcome
when applicable. Never relax task prompts, evaluators, timeouts or thresholds.

### Proposed heavy anti-regression campaign — awaiting user review

- Freeze candidate and main SHAs, dependency/fixture hashes, model/provider
  settings, task manifest, concurrency, repetitions and budget before launch.
  Compare the two revisions with matched inputs and interleaved run order.
- Feature cohort: `tree-feedback-routing`, `explore-agent-mid-run-message` and
  `browser-agent-mid-run-message`. Require the original three-active-layer trigger,
  outreach-only routing, corrected signature, and actual inbox consumption before
  completion. A root merely forwarding a message is insufficient.
- Fast deploy guard: `background-agent-message-smoke` is a separate 180-second-cap
  task tagged `smoke`. It uses two stable RFC Editor records and injects a user
  follow-up while the root owns a live background explore task. It requires the
  root to address that task, the task to take another step after inbox delivery,
  and both final records to contain the forwarded marker. The selector includes
  every smoke-tagged task in the deploy floor without a history gate; a static
  selector check currently places this task in a nine-task local floor.
- Anti-regression cohort: ordinary foreground/PLAN work, parallel and nested
  general-purpose/for-each work, explore/browser/code tasks, structured outputs,
  user corrections, waits, failures, cutover, auth and approval/payment lifecycles.
  Choose concrete existing catalog tasks before launch; do not substitute only the
  three new feature tasks or a history-selected smoke sample for this cohort.
- User-directed exclusion (2026-10-21): omit `agent-payment-abandonment` from
  all further validation. Do not retry, replace, or include that task in the heavy
  campaign. This exclusion does not convert its inherited ERROR into a pass and
  does not supply evidence for any remaining payment-lifecycle coverage.
- Proposed scheduled campaign, explicitly subject to user review:
  - Smoke admission: three scheduled candidate executions of
    `background-agent-message-smoke`, one within the complete deploy-smoke floor.
    All three must pass consecutively on the final candidate.
  - Feature qualification: ten candidate executions each of
    `tree-feedback-routing`, `explore-agent-mid-run-message`, and
    `browser-agent-mid-run-message` (30 attempts). Every declared routing/static
    invariant and every full-task evaluator must pass on all ten. Main is not a
    useful success control for features it does not contain.
  - Matched core anti-regression: ten interleaved main/candidate pairs each for
    `chat-mode`, `spawn-sub-agents`, `parallel-tool-calls`, `browser-smoke`,
    `claude-code-agent`, and `response-schema-non-goal-feedback` (120 attempts).
  - Matched extended anti-regression: five interleaved pairs each for
    `grep-agent-trajectories-code-tool-status`,
    `browser-auth-saved-password-retry`, and
    `agent-payment-new-user-journey` (30 attempts), plus three matched pairs of
    `test-mass-agent-run-0` (six attempts). The payment task is not abandonment;
    payment/provider execution remains held until this manifest is approved.
  - One complete deploy-smoke floor also exercises the remaining smoke tasks.
    Counting the smoke task only once where lanes overlap, the proposal schedules
    197 task attempts before any failure-driven investigation. There are no
    automatic retries or silent replacement attempts.
- Measure success per task/category; p50/p95 end-to-end and message-to-consumption
  latency; input/output/cache tokens and actual cost; duplicate/orphan counts;
  request/query rates, CPU/memory and per-agent payload growth. Distinguish
  execution, queueing, provider, evidence publication and cleanup time.
- Correctness floor: zero cross-tree delivery, lost acknowledged messages,
  duplicate external side effects, silently dropped corrections, leaked owned
  resources or invalid terminal tool states. A confirmed new regression blocks
  acceptance even if aggregate success improves.
- Proposed anti-regression margins: candidate pass count must be at least main's
  for every matched task and across the pooled matched cohort. For the six ten-pair
  core tasks, candidate p50 duration may be at most 10% above main and p90 at most
  20% above main; p95 is descriptive because ten samples cannot estimate it well.
  Median cost and pooled cost may be at most 10% above main. Correctness floors
  remain absolute regardless of aggregate statistics. These margins, concurrency
  and spending ceiling still require user agreement.
- Existing `test-mass-agent-run-0` is a broad real-agent fanout check, not a 10k
  proof. Before campaign readiness, define a provider-free matched data-plane load
  lane that seeds a deterministic 10,000-node tree and exercises tree reads,
  address authorization, inbox delivery and unread accounting. Run three matched
  fixture trials per revision; require zero cross-tree reads, lost/duplicate
  messages or unbounded query/payload growth, with candidate p50/p95 latency and
  peak memory no more than 10% above main. This harness does not yet exist, so the
  10k requirement remains an explicit readiness gap.
- Preserve original scheduled-total accounting and separate genuine task failures,
  infrastructure failures, cancellations and unknowns. Default infra stop remains
  `20 * infra_failed_jobs >= scheduled_total`, unless the user changes it.
- Every result must retain run/agent IDs, source identity, raw attempts, durable
  trajectory/LLM evidence and verified owned-resource cleanup. Publish the normal
  scorecard. No merge or deployment is authorized by campaign completion alone.

Historical results used to select this manifest (not acceptance baselines):

| Task | Historical pass rate | Recent signal | Passing duration |
| --- | ---: | ---: | ---: |
| `tree-feedback-routing` | 7/14 (50.0%) | 2/3 latest | p50 499s; p95 791s |
| `explore-agent-mid-run-message` | 9/19 (47.4%) | 3/3 latest | p50 192s; p95 250s |
| `browser-agent-mid-run-message` | 5/6 (83.3%) | 3/3 latest | p50 198s; p95 322s |
| `background-agent-message-smoke` | 0/0 | new; not executed | 180s hard cap |
| `chat-mode` | 626/639 (98.0%) | 10/10 latest | mean 38s |
| `spawn-sub-agents` | 602/652 (92.3%) | 9/10 latest | mean 180s |
| `parallel-tool-calls` | 611/642 (95.2%) | 10/10 latest | mean 157s |
| `browser-smoke` | 623/647 (96.3%) | 9/10 latest | mean 94s |
| `claude-code-agent` | 524/570 (91.9%) | 10/10 latest | mean 72s |
| `response-schema-non-goal-feedback` | 2/2 (100%) | only two attempts | mean 68s |
| `grep-agent-trajectories-code-tool-status` | 13/13 (100%) | 10/10 latest | mean 97s |
| `browser-auth-saved-password-retry` | 84/89 (94.4%) | 10/10 latest | mean 149s |
| `agent-payment-new-user-journey` | 178/193 (92.2%) | 9/10 latest | mean 158s |
| `test-mass-agent-run-0` | 209/252 (82.9%) | 10/10 latest | mean 267s |

The long-run rows come from the append-only attempts ledger after removing exact
duplicate rows and zero-duration cancellations. The three feature rows come from
the preserved run JSON files. These attempts span code/provider versions, so they
help choose stable and intentionally difficult tasks but cannot replace a matched
main/candidate comparison on frozen inputs.

### Handoff evidence and unresolved gates

Audit target: `119ee6fd2` (feature branch, PR #1563). Inherited receipts were
produced at different points in the branch; preserve their original identities.

- Fresh audit: five agent domains passed (background-agents, agent-control,
  wait-for, handle-tool-event, realtime-monitor); 41 frontend tests in three
  affected files passed. These are narrow checks, not full qualification.
- Review-only benchmark work: added the unexecuted
  `background-agent-message-smoke` catalog definition and its 180-second hard
  cap. Catalog/policy/task-selection checks pass (61 tests), JSON and diff checks
  pass, and a selector dry run includes it as `floor:smoke`. No benchmark was
  launched to obtain these results.
- Inherited agents coverage: 112 blackbox domains, 178 unit tests, 84% overall,
  stage exit 0. Inherited frontend coverage and lint/typecheck report passes.
- Inherited latest smoke: 9/10 passed, stage exit 1. browser-smoke agent
  `82fd33d9-b06c-49b1-9390-358691fbf1ac` reports an unresolved wait_for when
  browser screenshot ASSISTANT rows arrive before the wait's FINISHED row.
  Those attachments have no metadata. This is an open ownership/projection
  investigation; do not silence the invariant or call the benchmark fixed.
- Inherited backend coverage: 200/201 domains passed. browser-provider failed
  live Kernel `/rotate-proxy` with a proxy health-check timeout/unavailable error.
  Provider-side attribution remains unconfirmed; no gate waiver is implied.
- Inherited controller receipts: steps 0–10 exited 0, step 11 exited 1:
  513 passed, two supervisor INT/HUP cleanup tests failed, 1,020 deselected.
  The wrapper printed EXIT=0 despite GATE_RESULT exit=1. This is not a pass.
  The focused three-case shutdown rerun passed in 5.58s during this audit;
  that does not reproduce or clear the failure under the combined workload.
- Inherited AgentCard run `cf209eef-206b-47eb-93dd-dce9af6b77f5` finished with
  3/4 passed; `agent-payment-abandonment` is ERROR in the saved result, not a
  pass or skip. Its terminal snapshot has purchase HELD, funding RECLAIMING,
  card CLOSED with zero balance, and transfer consumed with 4,396 cents
  transferred / zero released. Earlier lifecycle reads returned an AgentCard
  organization-token 401. A later cleanup-skip warning does not change the saved
  ERROR verdict. The stage ended at 2026-10-21T00:15:14Z with exit 1. Both the
  benchmark-child and local-stack cleanup receipts are clean, and their recorded
  controller/service PIDs are absent. The full bundle was published to the Hub.
  Financial reconciliation remains open; clean process teardown does not prove
  the company transfer was released or the Stripe refund completed.
  Per the user's 2026-10-21 direction, retain this as historical evidence but
  exclude the task from future validation and do not require a rerun at the READY
  checkpoint.
  Semantic and E2B completion are unverified.
- Reporting gap found during closeout: the canonical scorecard's local-run
  loader applies fleet per-task completion markers to this local result format,
  rendering the completed tasks as queued. Use the saved run JSON and stage/
  cleanup receipts for this audit; do not publish that misleading card or alter
  the original evidence to make it look complete. Repair and regression-test the
  local-format reader before relying on its heavy-campaign scorecard.
- Offline attachment-path reproduction: the real `handle_tool_event` helper
  drops child metadata on `AssistantEvent` (even with `sub_agent_id` supplied),
  and the real realtime monitor records the unresolved-wait violation before
  the later FINISHED row. This reproduces the observed boundary; no fix or
  post-fix benchmark proof has been claimed.
- Independent review is incomplete: CodeRabbit was limited and the fallback
  exhausted usage. A skipped review is not proof this large implementation is sound.

Before the requested READY checkpoint: resolve the remaining in-scope failures
and evidence gaps, rerun the affected checks, bind the final receipts to the final
candidate, and present the reviewed heavy campaign manifest. Stop there for user
direction.

### Narrow regression diagnosis, 2026-10-21

These are targeted CLI checks after the inherited audit, not the reviewed heavy
campaign. PR #1563 remains unmerged; READY has not been claimed.

- Four archived browser-smoke / claude-code-agent realtime sequences failed the
  old unresolved-`wait_for` monitor and pass when empty child file attachments
  carry `artifactOnly: true` plus their file pointer. Authored assistant turns
  during an unresolved wait still fail. The helper now supplies that metadata;
  the monitor ignores only the explicitly marked empty attachment rows. Focused
  blackbox domains: handle-tool-event 4 pass, realtime-monitor 13 pass.
- Matched three-task local CLI comparison: candidate run
  `1792604578-1797974-24407` passed grep trajectory 43.0s, Lantern pagination
  186.6s, and signup-already-registered 570.6s (3/3). Main run
  `1792604946-1915647-12029` passed grep 62.7s and signup 511.0s; Lantern
  timed out after 303s against a 300s task cap (2/3). Its first `people_search`
  remained active until cancellation. An earlier main attempt
  `1792604730-1842472-90163` was invalid because its generated Prisma client
  came from the feature checkout; all three agent creations returned 500. It
  is excluded from task comparison. Its exact owned stack was later stopped and
  received a clean stack receipt. One matched execution per task cannot establish
  a flake rate, but these three do not currently demonstrate candidate drift.
- Focused candidate CLI run `1792606699-2379109-32045`: browser-smoke passed
  97.1s, claude-code-agent passed 106.6s; mass-agent failed in 41.4s because a
  legacy Fast Mode `execute_loop` replay omitted required `task_name`. A
  read-time, cache-only deterministic name repair moved the next mass-agent run
  `1792607133-2526300-47180` past that point, but it failed at 422.7s on
  `t10-no-tool-failures`: a cached `dag_param_populator` spawn still omitted the
  name. Those original failed results and grades are retained.
- The repair now covers any cached `spawn_agent` call with a missing name before
  schema validation. It preserves valid names and leaves live malformed output
  subject to normal validation. Fresh single-task CLI run
  `1792607738-2710762-23959` passed `test-mass-agent-run-0` in 250.5s,
  with 100% reported Fast Mode cache hits, 110 legacy names repaired across the
  tree, no missing-name validation errors, durable Hub publication and clean
  benchmark/stack cleanup receipts. The LLM blackbox domain passed 246 tests;
  lint and diff checks passed.
- The standard scorecard local loader now reads local terminal task statuses,
  canonical run JSON for failure reasons/cache rate, and owner-token-matched
  cleanup receipts. Its 31 tests pass, including a forged-token negative case.
  Previously generated incomplete-looking scorecard visuals are superseded by
  cards rendered after this correction; the original benchmark artifacts were
  not edited.
- 2026-10-21 validation rerun: backend coverage exited 0, with 305 unit test
  files passed, 201/201 selected blackbox domains passed (browser-provider in
  133.1s), coverage thresholds met, and the backend teardown checks passed.
  The intentionally separate live `integration-health` credential probe was
  skipped by the coverage runner and is not included in that pass claim.
  Frontend coverage exited 0 and met its thresholds.
- The combined controller selection passed 515/515 selected tests (1,020
  deselected) in 259.85s when launched in the foreground with `agents/venv`
  active. The original 513/2 failure was caused by the detached test shells
  inheriting ignored HUP and INT dispositions (`SigIgn=...0007` in `/proc`),
  preventing their signal traps from executing. The six exact stranded test
  processes from that run were identified, recorded, and terminated through
  their verified supervisor PIDs; none remained. A first foreground rerun
  omitted virtualenv activation and produced 508/7 with child-script
  `ModuleNotFoundError: httpx`; that environment-invalid result remains saved
  separately from the valid 515/515 result.
- The controller INT/HUP fixture now resets inherited ignored dispositions
  before executing its test shell. A focused run with both signals deliberately
  ignored in pytest's parent passed 3/3 cases, so detached launchers no longer
  invalidate this signal test.
- Agents coverage exited 0: 113/113 blackbox domains, 196 fast-cache tests,
  178 unit tests, and 84% overall coverage.
- The new `background-agent-message-smoke` passed a fresh isolated CLI run
  `1792610470-3524417-63976` in 51.0s. Its evaluator confirmed the follow-up
  arrived while the explore child was active, the root forwarded it by task
  address, the child took a later step, and both final records included the
  requested marker. Durable Hub publication, FE verification, and owned stack
  cleanup completed.
- The complete local deploy-smoke selection returned 9/11 passed. The existing
  `browser-biometrics-webdecoy` task reached `COST_LIMIT_REACHED` after its
  browser child visibly completed the checkbox and invisible form; recorded
  child usage was 278.238875c against the unchanged 120c cap. The original run
  JSON reported 0c because the runner settled tool usage before the delayed
  browser usage row was saved. The new messaging smoke received feedback while
  its child was active, but the child finished before the root forwarded it;
  `send_message_to_agent` woke that same task and its second run consumed the
  feedback. The initial evaluator rejected that completed-first race. Original
  failure artifacts remain intact.
- The smoke evaluator now explicitly verifies a same-task wake, second
  completion notification, and post-inbox progress for that race; the two deeper
  mid-run messaging benchmarks retain their strict pre-completion criterion.
  A fresh CLI smoke execution `1792612526-4085310-29379` passed 1/1
  in 63s, with durable FE verification and clean owned-stack cleanup. A focused
  transcript replay and the full benchmark blackbox domain passed after the
  evaluator update. The runner's cost settlement now waits for both call count
  and cost to stabilize above a known cost floor; its targeted regression and
  the full benchmark blackbox domain passed after that repair.
- The unchanged `browser-biometrics-webdecoy` task passed a standalone CLI
  recheck `1792612673-4123069-85917` in 156s at 1c, with clean stack cleanup.
  The failed trace took a screenshot at browser step 22, then made 20 vision
  fallback calls through OpenRouter as the screenshot remained in model context;
  the passing recheck made 24 Foundry calls without that fallback at its
  136-second observation. This is a route/cost correlation, not a closed RCA:
  the costly path is intermittent and has not been reproduced and fixed on an
  owning-boundary test.
- The next full local deploy-smoke selection returned 10/11 fresh tasks passed,
  with the prior `test-mass-agent-run-0` pass reused by its local cache. The
  new messaging smoke failed at 113s. Its feedback arrived during the first
  background run, and its same-task wake completed a second run with the marker,
  but the first completion notification was posted after the inbox write and
  before the send result. It was incorrectly stamped `backgroundRun: 2`, and
  the real second completion emitted no notification. The static evaluator also
  bounded progress at that first notification and reported zero post-inbox rows.
  The unchanged failed run and its root transcript are retained.
- Owning-boundary blackbox reproduction: a wake during the first completion's
  awaited tree update produced only one notification, labelled run 2. Capturing
  the completing run from its own record before the await made that identical
  repro pass; the first and second notifications now retain distinct run keys.
  The smoke evaluator separately recognizes a verified wake when the first
  notification falls between inbox persistence and the send result; it still
  requires a distinct second notification and progress after the inbox. The
  real failed transcript continues to fail this corrected check because its
  second notification is genuinely absent. The background-agent and benchmark
  blackbox domains, plus five consecutive focused test runs, passed after the
  repair. The unchanged messaging smoke passed an isolated CLI outcome run
  `1792614510-422489-12529` in 56s with clean stack cleanup. The full
  local deploy-smoke selector then exited 0: its 11-task isolated batch passed
  11/11, including the messaging smoke in 57s and biometrics in 156s at 10c;
  the separate shared-cache `test-mass-agent-run-0` batch passed 1/1 in 250s
  with 100% reported repeatable cache hits. Both batches published durable Hub
  bundles and completed exact owned-stack cleanup. The original 9/11 and 10/11
  failed runs remain preserved. Post-repair agents coverage completed: 113/113
  blackbox domains, 196 fast-cache tests, 178 unit tests, and 84% overall
  coverage. The run log is
  `.context/a2a/agents-coverage-post-notification-fix-20261021.log`.

Remaining gates include the live credential-health probe, semantic/E2B
completion, and independent review.
The excluded payment-abandonment ERROR remains historical evidence, not a READY
gate. The new background-agent feature qualification and full matched
anti-regression campaign have not run under the reviewed manifest.

## Goal

1. `spawn_agent` runs in the background by default (`run_in_background`, default `true`).
   The tool returns immediately with an address; completion arrives later as a
   notification row in the parent's conversation (Claude Code `<task-notification>` pattern).
2. Agents can message each other (`send_message_to_agent`) by Codex-style task path. The root sees its
   running agents in the environment block; explore agents can browse the tree with `list_agents`.
   Explore and browser agents (which run inside activities) can also receive messages.
3. A user message sent to the root mid-run is routed by the model, through
   task path + `send_message_to_agent`, down to the subtree it concerns.
4. Benchmark `tree-feedback-routing` proves 3: feedback lands while three levels
   of agents are active and must reach the outreach subtree only.

## System context

```
 user ──msg──▶ backend routeUserMessage ──signal receive_user_response──▶ ROOT workflow
                                                                         │ send_message_to_agent  
                                    backend POST /api/agents/:id/agent-messages (same tree only)
                                         │                         │
                                  DB row on target agent      parent-owned inbox row
                                  + signal receive_user_response   (explore/browser task address)
                                         ▼                         ▼
                              GP child workflow (poll)     explore/browser activity polls inbox
                                         │                 at each loop step
                                  spawn_agent(background) ──▶ grandchildren …
 completion ──child_completed signal / bg task done──▶ parent posts agent_notification row
            (excludeFromFrontend chip, model-visible USER row with notification metadata)
```

## Design decisions

- Background execution reuses the existing tool executors unchanged, run as a workflow
  asyncio task under the spawn's OWN tool-call id T (FE-neutral, 2026-10-19 user decision).
  The "started" row under T is `{runInBackground, hidden}`: the model's tool_result for T
  forever, hidden from the FE. Every executor row under T (or T:<n>) is `excludeFromModel`:
  the workflow stamps its own posts (`_background_row_metadata`), and the backend stamps
  activity-side writers under T's lifecycle lock when T already has a runInBackground row
  (`withBackgroundExecutionStamp`). The FE therefore sees exactly a foreground spawn's rows
  and the cached prefix never rewrites. Completion is a single new appended notification row.
- Planned (DAG) spawns start in the background through the same path (same "started" row,
  hidden bg rows, one notification). The DAG task completes when the child does
  (`_await_dag_background_spawn`), and dependents read the polled notification. A mid-plan
  user/agent message stops new tasks and returns needs_llm (no resume): background spawns
  keep running; an in-flight call_phone_number, message_person (approval) or
  send_message_to_user question keeps running and reports normally; every other in-flight
  task is cancelled immediately with a paired ERROR "interrupted" row.
  Fast Mode / simulate keep planned spawns in the foreground. Older snapshots with DAG
  "adoption" routes are converted on restore.
- Generation handoff / continue_as_new: background tool records park and resume in the
  background; general-purpose children are durable via `pending_children` + `child_completed`.
- attempt_completion is never rejected for pending background agents: it goes through the
  normal verifier, whose evidence ends with a factual "still running" status block (only when
  non-empty, so the verifier's cached prefix is unchanged). If the verifier accepts, the
  finishing parent (`_mark_complete` / `_mark_failed`) stops every pending agent: activity-backed
  tasks are cancelled, general_purpose/for_each children get `parent_finished` and stop as
  orphaned (a finished parent's `parent_state_query.is_finished` backs this up), and late
  `child_completed` signals are ignored. A rejection is ordinary verifier feedback. A turn with no
  tool calls gets the normal no-tool handling even while agents run; the model waits with
  `wait_for(agents=[...])` (2026-10-19 user decision: no idle/blocking wait).
- Environment context: a persisted `<environment>` USER row (metadata `environmentContext`,
  hidden) with date/timezone, own path/parent and running agents, appended only when it
  differs from the last one in the model context (so it is re-emitted after compaction),
  plus an unsaved `<environment-status>` tail (time to the minute, per-agent status/activity)
  appended after the cached prefix on every workflow LLM call (`helpers/environment_context.py`).
- Idle waits do not poll the cutover pointer. After a pointer flip the deploy
  (`broadcast-generation-handoff.ts`, run by `worker_pool_cutover.py` DRAINING and
  existing-process activation) signals `generation_handoff_available` to running
  AgentWorkflows on the old queue; parks wake, confirm via one pointer read and
  continue as new. Lost signals: 20-minute safety re-check. A background task that
  parks for handoff wakes the parent's wait_for the same way.
- Before a generation-handoff continue_as_new, in-flight background browser/code/explore
  tasks get a bounded settle (180s) to park/finish. Context overflow defers
  continue_as_new (keeps the compressed context in-run) while they run, until
  history pressure (30k events / 30 MB) forces a settle + continue.
- No classifier routing: the model decides where feedback goes (CLAUDE.md 25b).
- Scale (10k agents): per-agent signals and rows only; inbox polls are bounded `since` reads of
  one agent's rows; tree listing is one indexed query per call on the caller's root.

## Verification (automated)

- Agents blackbox: background spawn returns immediately; notification row appended once;
  completion reaches the verifier with the pending status; verifier accept stops pending agents; a tool-less turn gets normal no-tool handling (wait_for(agents) waits); environment block diff/re-emit + unsaved tail with byte-identical prefix; handoff parks/resumes background tools; explore inbox
  delivery; message rows never change response schema.
- Backend blackbox: agent-messages endpoint (same-tree auth, cross-tree 403, idempotency key),
  tree listing, inbox poll.
- Benchmark `tree-feedback-routing` (catalog, static checks + judge) via
  `scripts/run-bench --local tree-feedback-routing`.
- Benchmarks `explore-agent-mid-run-message` and `browser-agent-mid-run-message`: a NORMAL user chat
  message sent to the root mid-run (no special steering UI, no message addressed to the sub-agent) is
  routed by the root to the running explore / browser agent and steers it (inbox row before completion,
  browser steps after it), and its result reflects the message. The explore agent's `list_agents` showing explore/browser
  tasks is cemented in the agents blackbox (`background-agents`), not as a benchmark requirement.
- DAG (`dag-executor`, `background-agents`): mid-plan user/agent message breaks out to the execute loop
  promptly; background children keep running and notify once; blocking steps are cancelled immediately
  with paired rows; phone calls and pending approvals/questions are never cancelled.
- Waits (`wait-for`): every wait mode wakes on user message, agent message, agent notification and abort
  (kill / parent finished); `wait_for(agents)`
  wakes on listed agents only, honours `timeout_seconds`, parks/resumes across handoff.
- Later, with phone agents (not implemented in this PR): **Phone agents survive cutover** (`spawn_agent(type="phone")`, owning suites `background-agents` +
  `deploy-resume-e2e` with real Temporal): a generation handoff mid-call (1) never dials a second call —
  the relaunched poller re-initiates with the same idempotency key `agentId:toolCallId` and receives the
  same `call_id` (backend blackbox asserts the vapi initiate endpoint is idempotent on that key);
  (2) resumes polling and posts exactly one notification with the call result/transcript; (3) the cutover
  never waits on the call (handoff completes while the call is still in progress). Each case is written
  to fail first (repro) before the fix.
- All of the above run in the `/deploy` gates (agents blackbox domains, backend blackbox, structural);
  registration in the gate runners is verified, not assumed.

## Next pass (agreed with user 2026-10-19; prompt text pre-approved)

- Every wait wakes on user messages, agent messages, agent notifications and aborts (wait_for all modes).
- (Superseded 2026-10-19: no idle wait while awaiting a reply; wait_for(agents=["parent"]) instead.)
- `wait_for(agents: [paths] | "any", timeout_seconds)`: `timeout_seconds` only valid with `agents`
  (default 600, min 10, max 3600, Codex bounds); exclusive with `condition`. Returns what woke it +
  listed agents' status.
- (Superseded 2026-10-19: no `get_agent` tool. Status of running agents is in the environment block;
  other agents' history is read by an explore agent with `list_agents` + grep over agent_trajectories.)
- `send_message_to_agent` to a finished agent wakes it with the message as its next task (no followup tool).
- `kill_agent(to)`: kill target + subtree. A kill is a normal failure (FAILED, error_reason
  "Killed by <killer>"; descendants "Killed by <killer> (parent <p> was killed)"); no separate status. `interrupt_agent` was removed from the
  toolset (2026-10-19); redirect with send_message_to_agent instead.
- One shared "Working with other agents" prompt section (paths, waking, messaging, asking the parent);
  sub-agent question auto-reply explains asking the parent via send_message_to_agent + wait_for(agents=["parent"]).
- Later: port tree browsing to the SMS agent's `get_environment`.
- Later (not implemented in this PR): phone calls become `spawn_agent(type="phone")` (background by
  default, path, notification with transcript, environment block/banner, kill_agent hangs up). Same implementation underneath: the
  existing call_phone_number handler/activities/approval/simulate path, only routed through spawn_agent.
  Planner alias + row toolName: `spawn_phone_call_agent` (like spawn_browser_agent). Benchmarks counting
  `call_phone_number` keep working via runner name normalization (legacy name → new). send_message_to_agent to a
  live call: later (unsupported error for now). A mid-plan DAG break-out never cancels an in-flight call.

## Agent-to-agent content in the model context (Codex, 2026-10-19)

```
 stored USER row {agentMessage: raw text + fromAgentPath/toAgentPath/messageType}
            or   {agentNotification: rendered body}
   ──▶ build_llm_messages / convert_context_to_messages / planner
       {"role": "assistant", "content": InterAgentText(body)}       (never merged into a model turn)
   ──▶ _ensure_tool_result_pairing: inter-agent messages ride with the turn's non-tool content,
       AFTER that turn's tool results (never between a tool_use and its tool_result)
   ──▶ RoseClient.complete / planner builder: a TRAILING inter-agent message is sent as user
       role (every transport strips trailing assistant messages as prefill)

 body:  Message Type: MESSAGE | NEW_TASK | FINAL_ANSWER | FAILED
        Task name: <recipient path>
        Sender: <sender path>
        Payload:
        <text>      (FAILED payload capped Codex-style: 900 tokens head+tail,
                     "…N tokens truncated…"; FINAL_ANSWER uncapped)
```

The backend stores `messageType` (NEW_TASK when the send wakes a finished agent, else MESSAGE) and `toAgentPath`; the inbox endpoint returns `to_agent_path` / `message_type`.
Verifier: notifications are factual TOOL_RESULT evidence (same budget as spawn results);
agent messages are excluded (like the agent's own assistant turns). Storage stays USER rows, so
"not user authority" checks (response-schema feedback, real user instruction, DAG
break-out by metadata, planner goal, browser instruction sync) keep keying off metadata.

## Agent-to-agent control (implemented 2026-10-19)

```
 send_message_to_agent(to, message) ──▶ backend stores row ─┬─ target running  → signal receive_agent_message
                                                    └─ target finished → wake: CAS terminal→ACTIVE, Agent.goal = message,
                                                       start `<agent>:wake:<message id>` (execute, same tree launch config)
        target: the message only wakes it (wake kind "agent_message": waits end, a DAG breaks out to the
        execute loop); it is read at the next step. In-flight tools, background tasks and children are
        never cancelled by a message.   own activity task → inbox row (read at its next step)
 kill_agent(to) ──own task──▶ activity task cancelled + finished failed / durable child signaled `kill`
                └─else──▶ POST /:self/kill-agent (descendants only) ──▶ signal `kill` {by_agent_id, by_agent_path}
        target: _kill_request + _abort_run → _mark_failed(reason "Killed by K") → its background agents and
        children stop (parent_finished {killed_by, killed_parent} cascade); parent gets child_completed
        {status: failed, error_reason "Killed by K"} and one FAILED notification.
 rewoken child finishes again ──▶ parent appends a NEW <agent-notification> (original spawn result untouched)
```

No `get_agent` / `interrupt_agent` tools (removed 2026-10-19): running agents' status is in the
environment block; history is read by an explore agent (`list_agents` + grep over agent_trajectories).
Kill reuses the existing failure path: no separate killed status anywhere (agents, backend, FE all show
FAILED with error_reason "Killed by …"). Pause reuses the existing pause path: the agent goes PAUSED,
children get the pause cascade, in-flight background activities are cancelled and notify FAILED.

Semantics: only descendants and own background tasks can be stopped (not self, parent, ancestors or other
branches). Prompt: one shared
"Working with other agents" section at the end of MAIN_SYSTEM_PROMPT (static, cached prefix).
Tests: agents `agent-control` blackbox domain; backend `agents-agent-control.cases.ts`.

## Guards, inbox at scale, PLAN foreground, pause parity (2026-10-19)

```
 send_message_to_agent ──▶ backend sendAgentMessage ──▶ guardAgentMessage (agentMessageGuardService.ts)
        same idempotency key already stored ──▶ allowed (retries spend nothing)
        recipient unread ≥ 20 ──▶ 429 "<to> has 20 unread messages; wait for it to catch up …"
        sender GCRA bucket (burst 3, +1/s; Agent.agentMessaging.rateTatMs, one PK UPDATE) empty
                                 ──▶ 429 "Message rate limit: wait a moment before messaging <to> again."
 unread = agent messages to the recipient after its read mark; the mark advances when the
 recipient's own read returns them (worker poll GET /:id?since= → readAt; task inbox read:
 GET agent-inbox, explore post {inbox} → pending_inbox, browser read ?browserToolCallId → taskReadAt[address])

 explore step ── POST /:owner/messages {inbox:{task_id, since}} ──▶ pending_inbox (stashed, delivered next step)
               no answered read for 30s ──▶ one GET agent-inbox (fallback)
 browser step ── existing instruction read already returns the owner's USER rows ──▶ only
               agentMessage rows with recipientTaskId == own address become agent messages (no inbox GET)
```

- PLAN-phase spawns always run in the foreground (`_spawn_runs_in_background`); the PLAN schema
  has no `run_in_background`.
- Pause / cost limit cancel in-flight background explore/browser/code activities through the same
  `tool_stop_requested` check as foreground spawns; the notification reports FAILED (no separate status). Children get
  the existing pause / resume / cost_limit_reached cascade. Delete terminates the workflow, whose
  activities (background or not) are cancelled at their next heartbeat; child agents are deleted
  recursively.
- `wait_for(agents)`: `timeout_seconds` below 10 is clamped to 10 with a note in the result (Codex
  wait floor); above 3600 is rejected.
- Tests: agents `background-agents`, `spawn-agent`, `spawn-browser-agent-v3`, `wait-for`,
  `agent-control`; backend `agents-agent-message-guard.cases.ts`.

## Waking finished explore/browser/code tasks (user decision 2026-10-20)

```
 send_message_to_agent(to=<finished own task path>)
   ──▶ store the row on the finished run's inbox (backend guards: rate + unread cap, NEW_TASK)
   ──▶ _wake_background_task (workflow, deduped by message id): same task id / path / task_name,
       run n+1, inbox `<id>.run<n+1>` (earlier runs' rows are never re-read), goal =
       message + previous goal + previous result (capped head+tail), launched like any
       background task; refused while the owner is paused / killed / finishing / at its cost limit
   ──▶ rows carry `backgroundRun` (workflow stamp; backend copies it onto activity rows)
       → FE dock shows it running again, the trajectory gets a chip per run
   ──▶ new FINAL_ANSWER / FAILED notification (idempotency key `…:run<n>`)
 another agent's send (backend path resolution) ──▶ owner signal receive_agent_message
       {message_id, wake_task_id, message} ──▶ same wake (loop not woken)
```

- Agent.backgroundTasks keeps running tasks plus the owner's 10 newest finished ones
  (completed/failed), so list_agents, grep `trace_path` and send_message_to_agent resolve a
  finished task's path; a terminal owner lists only finished ones. The workflow keeps wake
  context (args + previous result) for its 10 newest finished tasks.
- Tests: agents `agent-control` (wake, dedupe, refusals, signal), `background-agents`
  (persisted finished entries); backend `agents-agent-address.cases.ts`,
  `data-agent-task-path.cases.ts`; front-end `background-agents.blackbox.tsx`.
