---
id: 2026-10-06-wmh-native-retries-duplicated-world-transitions
date: 2026-10-06
title: Native activity retries committed duplicate simulated world transitions
surface: agents
component: world-model-runtime
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: WMHHttpClient.step omitted native activity operation identity and the served WMH committed every retry
symptoms:
  - "assert len(session.history) == 2"
  - Native retry recorded the delivery state note twice
tags:
  - world-model
  - temporal
  - idempotency
sources:
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
  - commit 17cf59c7e
repro: agents/tests/blackbox/world_model_harness.blackbox.py::test_served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps
status: open
---

## Problem

Temporal can retry after a WMH mutation completed but completion acknowledgement failed. Previously, repeating the same action made two predictions and commits. Deduplication by tool-call ID alone would incorrectly freeze new polling activities.

## Diagnosis

What: at-least-once transport lacked operation identity. Where: runtime HTTP transport and served session commit. Why: wall timestamps change between attempts and the server had no native receipt. Proof: the permanent parallelism blackbox submitted two distinct actions twice each; before repair it failed the unchanged two-history assertion. Afterward it returned four observations with two overlapping predictions, two history entries, two state notes and two usage calls. Problem: logical inconsistency between native retries and simulated mutations.

Archive searches used `native activity retry duplicate WMH commit root child shared world` and `activity StartToClose timeout message_transport_send session`. The September 28 head-of-line case is a relative. This reproduction does not establish the historical fundraiser's $0 cause.

```text
native workflow/run/activity + stable action
  -> invocation header -> session receipt -> one prediction and commit
retry -> same receipt; new activity -> fresh concurrent prediction
```

## Solution

The client hashes native workflow/run/activity identity and the action without its generated timestamp. The server coalesces concurrent retries and returns committed observations without reapplying them. Failed predictions evict their receipt. Outside native activities, requests retain ordinary behavior. Permanent client and HTTP regressions cover retry identity and new polling operations.

Receipts reference observations already held by session history. Admission uses constant-time lookup under a short lock, never held during inference. At 10,000 actors there is no per-tree scan or backend query for invocation identity. Retention follows the per-run simulator's session lifetime; production agent traffic is unaffected.

Evidence: `.context/wmh-root-retry-before.log`, `.context/wmh-root-retry-after.log`, `.context/wmh-blackbox-final.log`. Matching model conformance and the unchanged fundraiser remain pending, so this WMH case stays open.

## Human feedback

Adversarial review reproduced a committed mutation followed by failed telemetry. The permanent served HTTP test failed before receipt publication was moved directly after state/history commit, then passed with one delivery note after retry. Genuine failed predictions remain retryable. Explicit production `is_error` survives extra receipt fields. Ending sessions now removes scope, lock and receipt maps. Two-action overlap is verified; conflicting-operation serializability and 10,000-agent capacity are not established by this fixture. Full-history copying/rendering remains a scalability limitation to measure in live runs, not a claimed cause of historical failure.

The user requires real root/GP loops, simulated boundaries, concurrent predictions, and actual simulated commitments and deposits. Prompts and outcome criteria remain unchanged.

### Native generation retirement follow-up

The exact native fundraiser `f5e4f83d-386a-4af1-84f5-7745216b6f27`
failed at the authorized 1,800-second limit with $0 raised. Root pause and
archive did not close native admission or join admitted provider work: commits
48–50 and additional provider usage followed the archive. The saved report
was therefore an earlier usage cutoff, not final settled accounting. The
portable audit is
`docs/plans/active/wmh-evidence-20261006/native-fundraiser-timeout-cleanup-review.json`.
This establishes a retirement ownership defect; it does not explain the
contact-route predictions or show that fundraising would otherwise succeed.

The first bad boundary was benchmark finalization treating a paused root as
proof of a finished native generation. The owning served-HTTP regression
initially returned HTTP 200 before actual provider cleanup joined. The private
bridge owning regression initially returned 404 while its provider task was
still active. Both unchanged assertions passed after explicit retirement was
added. Native retirement now closes admission under the session lock, joins
actual native/provider tasks, prevents later commits, and persists a frozen
state/history/revision/usage receipt. Transient waiter loss still preserves an
admitted operation and its retry receipt. Retirement rejects a stale attempt
to recreate the same root; a different root continues independently.

Benchmark finalization retires its own seeded native session before settled
cost, evaluator and archive work. Caller-supplied sessions remain caller-owned.
Each execution shallow-copies the cached catalog task, so two concurrent runs
cannot overwrite one another's root ownership. Failed retirement yields a
durable ERROR with original and retirement exceptions, skips settled-cost
credit, and continues independent exact-root/fixture cleanup. An admission
failure may recover only the generated seed-owned root UUID and must record
whether creation/deletion was actually observed. Ordinary resumable UI pause
does not retire a world generation.

Focused verification: 30 native checks, 54 provider checks, 79 benchmark
cleanup/wall-clock checks, 22 initial-state/cost checks and one actual HTTP
client receipt check passed. The task-sharing regression exercised two actual
overlapping `run_single_task` executions of the same template, each retiring
its own root once. Detailed local receipts are
`.context/native-lifecycle-fix-design.json` and
`.context/native-benchmark-retirement-final-proof.json`; they are focused
evidence, not frozen-source deploy or live fundraiser acceptance.

At 10,000 agents, ownership is scoped by native session and prediction ID;
retiring one root does not scan or cancel other roots. Compact admission fences
are bounded to 16,384 and fail closed at capacity. Frozen receipts are persisted
once and large in-memory graphs are released. The returned usage is the shared
provider process aggregate, not per-root billing. Full-history inference copies,
native memory/startup and 10,000 concurrent live agents remain unqualified.
The case stays open until the unchanged fundraiser and final deployment gates
pass. The separately proposed public-affordance prompt policy remains unapplied.

## Reusable lesson

Distinguish native retries from new repeated reads using operation identity, not action labels or wall timestamps.
