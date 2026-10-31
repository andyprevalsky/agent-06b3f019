---
id: 2026-10-31-it33-post-action-foreground-await-not-captured
date: 2026-10-31
title: It33 post-action stall lacks foreground-await ownership; bounded diagnostic qualified
surface: agents
component: browser-step-boundary
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: next iteration enters after successful switch_tab and control GET200 but the suspended foreground await is not captured
symptoms:
  - native PAUSED with progress zero and canonical FAIL
  - newest-active silence516s against510s
  - outstanding target requests coexist with later same-session replies
tags:
  - r139
  - foreground-await
  - cdp
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - agent 9707248e-9e41-4820-90b6-1fe62deffac2
  - plan: original archive 3a3b83d12db3472cca6056b6b2d1c628cc2961360231fe357af5ae18d8d8d5e8
repro: original suspended await unavailable; real-source offline controls prove missing diagnostic and prospective capture
status: open
---

## Problem

It33 r001-j0003, task polar-odysseys-0ab48db60760, executed71548b6/patchnone. Native PAUSED/progress0 after1067.2s and canonical FAIL remain unchanged. The driver reported newest-active silence516s against510s, cost/world-model idle1039s. All7 original normal manifest members independently verify against manifest828a4796e5a6221f5067a13600f26eab7f5177a8a8f13e01d09a723dc09bdc44. Normal collector75229 still exited1 because optional host report-card bytes changed after copying; the original7 matched. Parent separately verified exact release with canonical/mirror19files and original verified lifecycle. Collector failure, task outcome and release are separate axes.

## Diagnosis

The full1356-character task reaches both schema calls and every captured actor input. Its schema covers lentil type/water ratio/cook time, turkey chili title/vegetables, dessert URLs and two selections. All14 compressed payloads verify. No completion-verifier call/result or structured output was captured. Reported zero is the benchmark read of Agent.progress, not a verifier score; the original startup database write is not separately captured.

The last actor requests switch_tab to8A88. Native action8 is acknowledged at worker19703/04:55:04.835824 after passkey/credential preparation. Completed-prior-step timing19720/04:55:05.319757 means the next iteration entered. Exact-task control GET200/7ms ends at backend11105/04:55:05.328; there is no later model dispatch before cancellation. The response body, live cache and awaited Python stack are absent. The source next awaits control ownership, tab-runtime synchronization, instruction synchronization and guarded observation. An HTTP200 does not prove the worker returned from control processing. There is no later exact-task ACK/poll in the full backend log, so no positive evidence establishes voluntary user ownership either.

Outstanding calls on the recipe target include Page.enable and Runtime methods. Oldest-pending age reaches622s, but other sessions reply and the same DEFFA session has11 answered-again events. Exact715 silence_report measures oldest pending request age; _note_reply clears its warning when any response arrives. This is not622seconds without a reply or proof of dead global transport. Pause is later cancellation with cancel_requested=True/timed_out=False. No initiating vendor cause or unrecovered whole-connection failure is established.

## Solution

Original cause remains OPEN. Investigation constraints prohibit using progress telemetry, timeout changes or rewritten grades to mask the failure. The source and original logs were followed through the control/rebind/observation boundary; no captured frame identifies the suspended operation. Prior R112 and R118 cases were read after concrete symptom searches. Existing R118 cache-first lookup and provider keyboard/live-focus controls pass on exact715; this does not prove the original had a valid cache or waited in rebind.

A distinct observability improvement is qualified by exact patch8c8b5eb09450fcf7739f2047df7ef4c136f42bea447bb8addd18b5c1eedcf080. It adds start/terminal markers around the next-loop prefix and nested control/native focus awaits, binding hashed agent/task/session, step, trace ID and source-operation ordinal. These are not CDP wire request IDs. It changes no timeout, retry, cancellation, ownership, schema, result or progress policy.16 operations/33 own events per step bound capture; overflow is explicit. No raw URLs, inputs, outputs, errors or control bodies are added. Existing logger context is unchanged.

V1 was NOT_GROUNDED because a detached task inherited ContextVar and emitted after its parent ended. V2 additionally requires an active registered asyncio Task. Detached children do not regain attribution while a later operation reuses the same trace; explicit wait_for child operations remain instrumented. The reviewer’s unchanged reproducer and permanent lifetime control fail V1 and pass V2. All8 registered owning/compatibility controls pass independently;3 identical missing-diagnostic controls fail the original715 handler. Compile, patch and whitespace checks pass. This proves prospective diagnostics, not the original stall’s cause or task success.

Passing j0010 is only a different-task comparison: all7 original members verify, native COMPLETED/pass/progress1. Its34 completed-step records include rebind0–1820ms and user-control4–758ms. They confirm completed timing coverage but supply neither R139’s cache nor its awaited stack.

Primary reference implementations personally opened: Codex shell_snapshot.rs180–246 (owner-scoped async instrumentation), OpenClaw embedded-agent-subscribe.handlers.lifecycle.ts60–110 (scoped lifecycle and best-effort callback), Hermes chat_completion_nonstream.py140–210 (lifecycle chatter versus substantive progress). Full hashes and bounded excerpts accompany the review packet. Their timeout/reconnect policies are not imported. Diagnostics remain best-effort and may be unavailable after process death or beyond the explicit cap.

## Human feedback

The user prioritizes native failures, progress zero, and schema/validator data flow while retaining all failures in scope.

## Reusable lesson

A successful action and a completed prior-step timing record identify the next-loop boundary, not its current await. Record source-operation ownership before suspension and preserve the distinction between transport responses, intentional user control and task progress. Do not attribute detached background operations to a finished foreground span or infer vendor cause from old outstanding requests.
