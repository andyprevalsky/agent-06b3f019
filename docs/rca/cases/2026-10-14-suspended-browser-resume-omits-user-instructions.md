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
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_resumed_call_and_judge_receive_durable_captured_user_correction
status: open
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
adding task-specific coaching or rewriting the goal/schema.

## Solution

The local repair reads the durable USER tail once on activity resume, after
lossless archive hydration. A persisted timestamp overlap and source-ID ledger
preserve message order and include distinct rows with the same timestamp while
preventing duplicate delivery. Hidden generated schema context is excluded.
The browser actor and both verifier paths receive the same actual user
instructions, with the original delegated goal retained. Real task feedback
no longer creates a false authentication-completed cue; only the explicit
backend completion marker does. Declined authentication still ends without
fetching input or making another model call.

The final owning reproduction drives the actual resumed activity and verifier
request construction using the exact captured original goal and correction.
Command: source agents/venv/bin/activate; python
.context/rca-ae17b024/rca-browser-repro.py. The RCA_BASELINE=1 switch selects
unchanged HEAD handler/service in an isolated module namespace; assertions,
request data and fixture are identical. Baseline: exit 1 after 0.646 seconds,
"resumed actor lost or duplicated the durable user correction". Candidate:
exit 0 after 0.850 seconds, exact correction delivered once to the actor and
judge. Six focused regression/lifecycle controls passed. The permanent
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

Golden references read: codex/codex-rs/core/src/session/input_queue.rs:389
drains pending typed input; hermes-agent/agent/agent_runtime_helpers.py:3758
appends actual steering as a standalone user row after a tool batch;
openclaw/packages/agent-core/src/agent-loop.ts:221 commits queued input before
the next model call; claude-code-src/src/query.ts:1570 drains scoped queued
commands. The repair converges on preserving original user input at the next
execution boundary rather than manufacturing a recovery nudge.

The case remains open pending snapshot-scoped runtime-context approval and
deployment. The trajectory-injection guard explicitly requires approval. No
production agent was resumed, rerun or modified during this RCA. At 10,000
agents the design adds one scoped durable-tail read per resumed task, with no
new per-step polling or shared user fan-in. Existing auth, write-permission,
payment and generation snapshots preserve the same instruction custody.

## Human feedback

The user asked to continue the RCA and reported "failed to pause agent" on
mobile. No implementation approval or gate override was recorded.

## Reusable lesson

Deliver the durable user instruction tail to resumed delegated work and its evaluator before the next model call, using signals only to wake the owner.
