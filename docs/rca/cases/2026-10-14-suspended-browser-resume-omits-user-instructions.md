---
id: 2026-10-14-suspended-browser-resume-omits-user-instructions
date: 2026-10-14
title: Browser resume omitted a durable user instruction while continuing the superseded task
surface: agents
component: spawn-browser-agent-v3 resume instruction custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SpawnBrowserAgentManagerV3 resumed the parked browser with session continuity and an authentication-completed cue but omitted the newer durable USER instruction from both actor and verifier context
symptoms:
  - Update Do NOT sign in with tamara@roselabs.ai was absent from resumed browser requests
  - User Assistance Received followed by continued Tamara account recovery
  - Verifier rejected (50%) — continue task
  - Wrong password
tags:
  - browser
  - user-feedback
  - auth-assistance
  - resume
  - verifier
sources:
  - agent ae17b024-5287-4199-84d0-6cce3bd1765d
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
  - PR #1511
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_resumed_call_and_judge_receive_durable_captured_user_correction
status: fixed
---

## Problem

The SMS agent was asked to list Tamara's October 14 calendar events. The browser
encountered an authentication blocker and requested assistance at 17:24:53 UTC.
At 17:28:33.341 UTC a durable USER message explicitly changed the task: do not
sign into Tamara's account; use Andy's account and find a shared calendar or
events mentioning Tamara instead. The same browser session resumed at
17:28:37 UTC. Its first resumed reasoning at 17:28:41 UTC treated the reply as
completed authentication and continued toward the original account.

The investigation preserved all 234 root messages and 87 unique archived LLM
dumps. Resumed browser step 21 through step 49 and all 16 captured browser
verifier requests omit the correction. The transcript records 15 rejected
completion attempts with a 50% score. Lack of Tamara credentials preceded the
correction; it does not explain why the correction disappeared from later inputs.
The later pause failures and deletion are a separate incident.

## Diagnosis

Critical path: durable USER message -> workflow response/unpause -> parked
browser manager -> resumed activity continuity -> browser model request ->
browser completion verifier. The parent loop remains inside the browser tool
manager, so its normal message polling cannot update the running delegated task.
The handoff preserved browser history and session state while treating the
new reply as a wakeup rather than preserving its instruction content.

Exact captured first-resume dumps are 502467326c47 and 9636f87a7e0b; the final
browser actor dump is 67c0dd5c75ac. Private raw requests, transcript and Render
evidence remain under .context/rca-ae17b024. Missing model input, rather than
model intelligence, is the evidenced failure. Forwarding the correction does
not prove successful Google login, calendar access, or the final schedule.

Retained worker rows confirm receipt of the 755-character keyed signal at
17:28:33.446890 UTC, storage for auth request
68016e7d-4054-4c9e-8430-925c1b0c3b21 at 17:28:33.447070 UTC, and browser
resume from step 20 at 17:28:34.318523 UTC. The manager checked rejection
semantics and discarded the actual reply before the model request. This
incident is not a failed-signal delivery problem. Durable polling also closes
the documented sibling contract where a best-effort signal fails but its USER
row remains available.

Archive searches used user correction browser auth assistance resume goal;
authentication assistance old goal ignores user message; browser ignores
followup; and auth-assistance resume correction. The payment-request verifier
case of September 29 and stale auth-context case of October 13 are relatives
with different first-bad boundaries; neither is a proven recurrence.

The stopped class is instruction custody across suspended execution and its
evaluation. The next more general class, preserving all mutable session/task
state across every external suspension, is not a coherent repair here: those
states have different owners and contracts, and this evidence concerns actual
user instructions. The repair transports original user content rather than
adding task-specific coaching. The original incident proves missing input; it does
not prove the root calendar-events schema was wrong. The final browser verifier
request 56a48ebda7ec independently confirms a stale delegated schema: its required
signed_in_account field says the account should be tamara@roselabs.ai after the
user explicitly directed Andy's account. Native schema refresh therefore also
repairs an evidenced browser contract mismatch, while additional-field
regressions cover the user's broader schema-update request.

## Solution

The repair reads the durable task input range after lossless archive hydration
and before active decisions. An immutable task boundary and source-ID ledger
include late commits and distinct rows sharing a timestamp without duplicate
delivery. Hidden generated schema context is excluded. The initial advancing
timestamp implementation and epoch-only legacy fallback were superseded by the
October 15 follow-up below.
The browser actor and both verifier paths receive the same actual user
instructions, with the original delegated goal retained. Real task feedback
is preserved verbatim. The auth-resume cue and its synthetic USER-message
helper are removed entirely, including on explicit backend completion. Declined authentication still ends without
fetching input or making another model call.

The final owning reproduction drives the actual resumed activity and verifier
request construction using the exact captured original goal and correction.
Identical command: source agents/venv/bin/activate; RCA_BASELINE=1 python
.context/rca-ae17b024/rca-browser-repro.py. The switch loads the committed HEAD
handler/service in an isolated module namespace; assertions, request data and
fixture are identical. With buggy HEAD b784977b0: exit 1 after 0.646 seconds,
"resumed actor lost or duplicated the durable user correction". Candidate:
exit 0 after 0.850 seconds; the same command with committed fixed HEAD
e015fe45c passed in 0.684 seconds, exact correction delivered once to the actor
and judge. Six focused regression/lifecycle controls passed. The permanent
spawn-browser-agent-v3 runner discovered all new regressions and passed:
1 domain passed, 0 failed, 55.3 seconds. Ruff, compilation and diff checks
passed. The fixture drains its owned asynchronous browser cleanups.

Independent review found and resolved two initial-candidate flaws: a
signal-only feedback buffer missed the durable-source contract, and archived
continuity hydration overwrote fresh outer instructions. The final regression
also covers pointer-backed hydration, multiple rows, timestamp ties, repeated
identical text from distinct source IDs, repeated resume and generation
continuity. Legacy snapshots without a cursor read the complete durable USER
history once; this can repeat pre-task instructions. New snapshots use the
activity's scheduled-time watermark and continue from its persisted cursor.


The revised schema contract uses each delegated task's own current schema and
actual user messages with the existing schema generator. It preserves selected
compute credentials and native usage/cache identity. No input means no schema
generation; declined authentication makes no additional model call. Updated
schemas persist in continuity state and reach the actor, both browser verifiers,
and terminal metadata. The root workflow now queues genuine keyed replies for
its native schema refresh and updates its system contract directly, without a
hidden USER row. Exact auth-completion and rejection protocol responses do not
become user schema feedback.

Three permanent root workflow tests failed before the revision: keyed feedback
left its schema stale, the actor retained an old contract, and a new instruction
fabricated a USER row. The identical three assertions pass afterward. Full
workflow blackbox passed in 41.0 seconds and workflow determinism passed all five
checks in 0.6 seconds. The final frozen browser, timing, and shared LLM domains all passed in 65.7
seconds, including all 226 LLM checks. The new no-input auth and delegated-schema
regressions failed before their revisions (1.249 and 0.865 seconds) and passed
unchanged afterward (0.995 and 0.981 seconds). Stronger controls cover native
compute auth, real usage/cache identity, archived schema deduplication, and
declined auth. Infrastructure gate markers (RESOLVED, SOURCE_CONNECTED, and
SUBSCRIPTION_ACTIVE) also remain control state: the expanded owning assertion
failed before and passed after parsing the observed reserved protocol values.
The first whole agents-coverage attempt passed 109 of 110 domains; the
remaining deploy-resume fixture omitted the newly required durable-message
route. Adding that API-shaped fixture route preserves all existing handoff,
exact-once completion, billing, and timing assertions. The unchanged owning
suite now passes in 26.2 seconds. The repeated merged-source
coverage run passes all 110 agents domains, 184 fast-cache tests, and 134 unit
tests, at 82% coverage (337.0-second recorded stage).
All 46 deploy structural gates passed. The merged-source backend and frontend
typechecks pass with zero errors; frontend lint passes with nine warnings.

The first CodeRabbit cycle exposed additional suspension boundaries. Schema
generation failure must not prevent delivery of actual input: the browser now
keeps its accepted schema, delivers the message, and retains a retryable schema
revision across suspension. The schema generator uses the root's existing
preserve-unaffected-fields contract; acting-model history gains no synthetic
turn. New input also invalidates a previously queued browser action so the
next action is chosen after reading the correction. Six permanent browser
regressions cover these paths; the browser and timing domains pass together
in 57.9 seconds.

Reserved protocol values are excluded after whitespace normalization while
genuine authored text retains its original bytes. Its unchanged owning
assertion failed before this correction and passes afterward. Background root
schema generation now has no persistence side effect: only an accepted
revision is written through the generation-fenced API. Continuation prefers
that accepted native schema if the database write failed or its acknowledgement
was lost. Five causal persistence regressions failed before and pass after;
the workflow and LLM domains pass in 52.9 seconds and worker registration passes
32 tests in 71.0 seconds.

The shared transport audit also reproduced a producer-side loss: typed
approval replies reached the keyed signal without creating a durable USER row.
Text-entry producers now send an explicit optional user_message, preserving
the original bytes separately from the approval protocol response. Default
buttons, explicit token overrides and generated completion notices omit that
field. The unchanged frontend request-body matrix goes from 13 failures to
29 passes; five owning suites pass 255 tests with one existing skip. The backend
stores authored input in the same transaction as gate resolution, then
broadcasts and signals after commit. Request-linked source identity and the
existing attention lock cover retries and waiters joining during resolution;
the browser continues using the same durable message stream.
The same transport includes auth completion and accepts the first authored
reply when an automatic control event resolved the gate first. Identical
retries reuse its canonical row; a different later reply receives HTTP 409
instead of a success response that discards text. The unchanged final backend
reproduction fails five attention cases and two authored-auth cases on the
previous implementation, then passes both owning domains (42 attention cases;
3.691 and 2.215 seconds). Durable insertion and gate resolution roll back
together on failure, before signaling.

New keyed signals distinguish authored user_message from an explicit null
protocol-only value. The root keeps the gate response unchanged and uses only
the authored value for schema feedback. Signals from legacy producers without
the field retain their existing behavior. Two permanent receiver regressions
fail against the previous receiver and pass afterward; the owning workflow
suite passes in 41.7 seconds. No USER or TOOL narration is manufactured.

Golden references read: codex/codex-rs/core/src/session/input_queue.rs:389
drains pending typed input; hermes-agent/agent/agent_runtime_helpers.py:3758
appends actual steering as a standalone user row after a tool batch;
openclaw/packages/agent-core/src/agent-loop.ts:221 commits queued input before
the next model call; claude-code-src/src/query.ts:1570 drains scoped queued
commands. The repair converges on preserving original user input at the next
execution boundary rather than manufacturing a recovery nudge.

The fix is locally verified; deployment verification and retained evidence are tracked in PR #1511. The user explicitly directed removal
of harness injections, preservation of sent user messages, and schema updates
when needed. That direction authorizes this scoped runtime change; the normal
trajectory guard is satisfied with recorded user-direction provenance. The deleted
incident agent was not resumed, rerun or modified during investigation. At 10,000
agents the combined repair reads each task’s scoped durable tail at resume,
decision and verification boundaries through the same cursor/source-ID ledger.
It adds no shared user fan-in or second input transport. Existing auth, write-permission,
payment and generation snapshots preserve the same instruction custody.
PR #1511 contains the combined native runtime repair. The normal deploy prompt and agent
terminal-behavior guards passed; Step 0c initially stopped on the runtime-context
diff, then passed under the user's explicit revised implementation direction.
The evidence publisher could not produce a share viewer for this deleted
non-benchmark agent because its current CLI requires a Hub run UUID. The final
verifier dump 56a48ebda7ec was rendered and published separately with a 7-day
signed HTTPS URL. The deleted agent's frontend viewer was not validated. Deployment verification is tracked in PR #1511.


## October 15 review stabilization: durable task range

The final verification review of immutable `9b8b694bb47f211443b3d3a32fe375036f7bed5c`
returned valid findings. The three-cycle deployment was recorded blocked as
review-unstable; no fourth review or merge occurred. These are subsequent
isolated development fixes, not an approval to merge that reviewed candidate.

Two timestamp defects remained in the initial repair. A new TOOL or USER row
advanced the observed timestamp past an older USER transaction that had not yet
committed, permanently excluding that authored input from later reads. A legacy
snapshot without a cursor read every historical root USER row, including input
from unrelated tasks. The source-ID ledger deduplicated visible rows but could
not recover rows omitted by the timestamp query.

The range now stays anchored to the task's native start; it never advances to an
observed message timestamp. New activities retain Temporal scheduling time.
Legacy recovery reads the existing manager `session_starting` ToolEvent keyed by
its actual `toolCallId`, through the same message poll. This event is persisted
by `helpers/handle_tool_event.py` before scheduling either real or simulated
browser work. Browser init and `task_started` rows are emitted after preparation
and cannot supply that earlier boundary. The current tool-call identity is
reconstructed from the real activity argument, rather than guessed from text.
A snapshot with neither a saved boundary nor this actual source fails closed.

The message helper's optional projection retains actual USER rows and only the
exact native manager start. It bypasses model-context compaction for this source
read and excludes browser internals. Existing source IDs own deduplication;
there is no second signal replay path, temporal overlap allowance, generated
user instruction or invented simulated start event. The permanent shared fixture
executes the actual manager's first yield and the standard ToolEvent handler to
obtain the source metadata. It proves the producer exists in both modes.

Seven browser causal regressions fail unchanged against `9b8b694bb`, then pass:
heartbeat startup and cleanup (described in the related active-browser case),
superseded verifier closure, late USER commits behind newer TOOL and USER rows
across resume, exclusion of unrelated legacy history, and explicit refusal of a
missing boundary. The legacy source test places the real correction after the
manager source but before later browser preparation completion. It therefore
also rejects a `task_started` timestamp or resumed scheduling-time substitute.
The message projection regression fails on `9b8b694bb`; its actual producer
control already passes that baseline. All nine checks pass after the repair.

Exact unchanged commands in the isolated development worktree were
`agents/venv/bin/python .context/review3_focused.py` and
`agents/venv/bin/python .context/review3_extra.py`.
`review3-causal-proof.json` records the baseline, SHA-256 of all four permanent
fixture files, unchanged assertions, exit statuses, durations and before/after
console paths. Before: seven failures in 1.960s plus the missing projection
failure and preserved producer control in 0.591s. After: all seven pass in
2.110s and both projection/producer checks pass in 0.650s.

Archive searches were `browser heartbeat schema generation verifier IN_PROGRESS`
and `late committed USER timestamp cursor legacy resume task history`. The
original suspended-input and active-input cases are the same owned boundary;
the CDP heartbeat case is related. Golden reference reads included Claude's
`src/bridge/replBridgeTransport.ts:60` native event delivery identity and server
sequence cursor, Hermes `agent/agent_runtime_helpers.py:223` identity-based
validated-prefix handling, Codex `codex-rs/core/src/tasks/regular.rs:120` pending
input before completion, and OpenClaw
`src/infra/outbound/delivery-queue-lease.ts:77` independent liveness lifecycle.
They retain native source/operation identity rather than manufacturing user
turns. Rose's timestamp-only storage is not a commit-order event sequence, so
removing watermark advancement is the coherent simplification here.


The retained incident transcript independently contains the same durable source:
row `13e9318d-50d3-4a4b-aa74-a8f9be7c40ec` at 17:21:46.577 UTC has native
`session_starting` and `toolCallId=e52b1fbb7`. Later init row
`26534b28-5150-422d-93de-b906defc5036` at 17:22:05.354 UTC binds that call to
browser task `3a5940f4-585a-5744-bdcc-bde9ab0da653`; its separate `task_started`
row follows at 17:22:05.515 UTC. This is observed producer/storage provenance,
not an invented fixture-only event.

Combined development validation from `agents/` passed all six owning domains
in 104.1s: `venv/bin/python scripts/run_blackbox_tests.py
spawn-browser-agent-v3 world-model-harness messages workflow
workflow-determinism handle-tool-event`. The permanent runner discovers the
new cases. An earlier invocation from the worktree root failed three existing
relative-path fixture reads in 62.7s; that failed attempt remains preserved and
is not counted as runtime validation. Scoped Ruff, archive validation (871
cases after main synchronization), compilation and diff checks also pass.
The main synchronization changed benchmark history and docs under `agents/`,
not these tested production/owning-test sources.

## Human feedback

The user asked to continue the RCA and reported "failed to pause agent" on
mobile. The user then directed: "We shouldn’t have any harness injections, we
should just perserve the user message if sent & update output schemas if needed".
The revision removes synthetic auth-resume and hidden schema-update USER rows,
keeps genuine messages, and updates native output contracts. No gate override
was requested or inferred.

## Reusable lesson

Deliver the durable user instruction tail to resumed delegated work and its evaluator before the next model call, using signals only to wake the owner.
