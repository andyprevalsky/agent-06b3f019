---
id: 2026-10-15-sealed-generation-cleanup-admitted-new-owned-work
date: 2026-10-15
title: Sealed-generation cleanup admitted new owned publication work
surface: agents
component: spawn-browser-agent-v3-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: activity finally awaits the native inbox drain after a known seal and best-effort cleanup helpers swallow first writer sealing
symptoms:
  - held native poll appended input after foreground seal
  - sealed generation was swallowed by the activity
  - new work after first cleanup seal
  - abort enumerated every agent waiting queue
tags:
  - workflow-generation
  - cleanup
  - cancellation
  - recorder
  - ownership
sources:
  - commit c82a43d748dfc8c2653f9acfe75923251b4f19f0
  - commit 5a83ece839a48fd224aa8248dbd04223a40c89ca
repro: agents/tests/blackbox/cleanup_sealed_behavior.py
status: mitigated
---

## Problem

Focused actual activity/cleanup controls show two ways to admit new writes after an authoritative native generation seal: an already-known foreground seal yields to an inbox poll before cancellation, and first-seal signals from diagnostics/recording/terminal writers are swallowed by ordinary best-effort catches. This is a retained lifecycle contract gap, not the cause of the three unresolved live auth-choice failures.

## Diagnosis

Exact c82 with the same controls produces activity30PASS/1FAIL: a held poll completes in finally and appends input after foreground sealing. First-writer controls produce3PASS/6FAIL: actual repo.save_browser_action_message HTTP409 in diagnostics admits storage/recording/terminal/native-close work, recording admits terminal/native-close, terminal admits native-close, finally diagnostics/resolution swallow the typed signal, and a first seal in generic-error fallback skips owned local disposal. HTTP500 ordinary best-effort controls already pass. The real repo.py writer is byte-identical to c82; this is not a synthetic close409 exception.

The root ownership error is treating shutdown as permission to continue normal publication after native authority has terminated. The initial local-abort implementation also enumerated all agents' waiting queues. Exact per-owner key access observation with100 foreign queues fails on c82; timing/cap changes are not used as proof.

Evidence: .context/coherent-c82-correction-receipt.json and retained before/final logs. Corrected activity31/0, owner8/0, first-writer9/0; hard network attempts0, same MAX250. Real APIs settle six owned tracked tasks and one download task, preserve ordinary diagnostics/recording/terminal/connection/driver cleanup, and leave no pending owned async archive at the controlled artifact boundary. Same-directory foreign recorder/mixed-future controls pass. No live calls.

Archive search WorkflowGenerationSealed cleanup recorder terminal found browser-session-state-survives-task-completion and cloud-archive-preceded-browser-cleanup. Those concern related lifecycle ownership but do not establish recurrence of this exact known/first-seal publication gap.

## Solution

Synchronous cancel of the owned poll before any yield on known sealing; propagate genuine typed seal through the narrow best-effort writer paths; set the activity seal flag at finally resolution/diagnostics boundaries; route first background seal and generic-error fallback seal through one owned-local disposer. Producer-maintained per-recorder waiting-key indices avoid global scans and preserve foreign custody. Existing ordinary2s drain, numeric bounds and ordinary exception behavior remain unchanged. Registered controls and review-only5a83 contain the correction; no source adoption.

Only owned async work is settled. Already-admitted thread/native transfers and mixed foreign batches cannot be undone, and background first seal cannot retroactively alter an already-returned business result. Globally queued realtime messages are not broadly cancelled. Updated combined preview/full canonical proof and exact-hunk human classification remain outstanding. Historical behavior PASS omitted handler.py and did not prove stop-flow approval. Original auth/Gmail/manager receipt remains separate.

## Human feedback

The parent required independent usable OTP delivery and durable-reference acknowledgement, bounded existing polling/action limits, no prompt/tool/task/evaluator or timeout changes, strict offline network guards, exact before/after owning controls, and review-only checkpoints before any adoption. Parent rejected implementation-mirroring assertions, retained-map provenance expansion, global archive scans, path-derived ownership and treating sealed generations as transient failures.

## Reusable lesson

Stop new owned publication synchronously on authoritative sealing and dispose only resources whose exact instance custody is known.


### Golden-reference qualification

Parent independently read OpenClaw src/agents/provider-local-service.ts:542-572 (cancel a waiter while the captured process owner remains until settlement), Hermes gateway/run_agent_cache.py:292-302 (a stale owner cannot clear a newer run), and Codex codex-rs/core/src/tasks/mod.rs:958-990 (bounded abort cleanup before interruption publication). These support exact owner settlement and fencing as architectural analogies; none proves rollback of an already-running provider transfer or the current auth task outcomes.


### Final terminal-writer review follow-up

Review of7d3d1aa98aafb07ecae0ee55cefa97c2ae632c7c found the cancellation terminal writer still inside generic Exception suppression. A new actual full-activity control uses real repo.save_browser_action_message with mocked native HTTP409: the signal is swallowed, cancellation returns normally and background teardown emits Browser Session Closed. Replacing that one suppression with the existing typed-preserving cleanup context exposes the identical adjacent Task Failed writer defect; its unchanged control also fails before the second replacement. The final correction is exactly those two context-manager replacements. The same registered control covers cancellation and original-error terminal writes at409, plus ordinary500 positives. All four pass with hard network attempts0; no retry, timeout, user-auth policy or business outcome change. Initial capture-body decoding harness error is retained separately and is not causal proof. This remains review-only and does not repair the three auth-choice task failures.


The same finite error-reporting chain also swallowed genuine native-message seals from the initial Updating credential state write and from Credential state update failed after ordinary propagation failure. Actual full-activity controls use real message persistence with mocked409:116 fails the progress case; preserving the outer propagation catch exposes the diagnostic case; preserving the inner diagnostic catch makes both409 and ordinary500 controls pass. The correction adds only explicit typed-seal rethrows before those two ordinary catches. The propagation API has no native409 mapping, and no such mapping or generation authority was invented. Original browser errors remain unchanged for ordinary propagation/message500 failures. These are four additional registered source-bound cases, not original auth benchmark repair evidence.
