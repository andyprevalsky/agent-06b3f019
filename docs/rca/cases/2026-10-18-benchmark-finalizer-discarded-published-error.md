---
id: 2026-10-18-benchmark-finalizer-discarded-published-error
date: 2026-10-18
title: Benchmark finalizer discarded a published ERROR after physical phone cleanup failed
surface: harness
component: benchmark-task-finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: main_async finally cleared evaluated task results before promoting an exception-aborted serial occurrence into saved task results
symptoms:
  - PhoneCleanupBlocked Phone cleanup deadline exceeded retain isolated database
  - published ERROR reverted to queued during finalization
  - cleanup replaced the terminal ERROR and skipped collector joins
tags:
  - benchmark
  - phone
  - cleanup
  - report-card
  - task-ownership
sources:
  - commit 33bf65449502dd377dec57f576f8590bdb091d71
  - plan:.context/phone-harness/live-connectivity.log
  - plan:.context/phone-harness/benchmark-phone-finally-before.log
  - plan:.context/phone-harness/benchmark-phone-finally-after.log
  - plan:.context/phone-harness/benchmark-terminal-report-before.log
  - plan:.context/phone-harness/benchmark-terminal-report-after.log
  - plan:.context/phone-harness/benchmark-lifecycle-registered.log
repro: agents/benchmarks/phone_connectivity_test.py:test_failed_phone_cleanup_drains_owned_collectors_and_preserves_error
status: open
---

## Problem

Frozen checkpoint 33bf65449502dd377dec57f576f8590bdb091d71, canonical run
phone-connectivity-20261018t2006, Hub 067c92bc-db62-472e-9eeb-41f4fdc4bde0,
root d593a517-5faf-4b5f-9805-23629fe48d1d printed PhoneCleanupBlocked at
20:15:45 UTC. The log subsequently showed running=1/completed=0 while error
evidence was collected, then failed, then queued=1/completed=0. The owner JSON
was running with PID 2852775 and its token-owned cleanup receipt was pending
when read. No owner/receipt file was edited by this investigation.

The parent reports TERM at 20:16:53 only to its controller PID 2840603, after
the original failure. The log records top-level Fly/Supabase collectors stopping
naturally (333460 lines/317 frames), and parent reports exit 1 retaining services
and DB. TERM is not the cause. No production collector leak is claimed.
Physical READY after logical release is separately owned and not fixed here.

## Diagnosis

Path: failed physical cleanup -> task catch builds/publishes ERROR -> task
finally repeats physical cleanup -> exception replaces the return before local
collector joins -> serial coordinator never appends result -> main finally
clears the evaluated overlay -> report derives queued and no saved occurrence.
The observed queued regression is the report finalizer's first bad publication
boundary. The exception/join problem is independently proven locally, rather
than inferred from the natural top-level collector shutdown in the live log.

Archive searches: `PhoneCleanupBlocked realtime cleanup` and
`benchmark collector teardown finally exception`; read process-feedback and
2026-10-04-direct-fleet-live-results-waited-for-teardown. That case is a relative:
it repairs pre-teardown transport/publication, while this failure discards an
already published result on an exceptional return. A distinct local finalizer
reproduction is required and included here.

Golden-reference searches covered all four local references. Claude Code
src/utils/cleanupRegistry.ts:23 starts all registered cleanups; Hermes
 gateway/stream_consumer.py:497 completes its boundary notification in finally
independently of processing failure. OpenClaw src/browser-lifecycle-cleanup.ts:31
separates cleanup error reporting from lifecycle work. Codex
codex-rs/core/src/tasks/mod.rs:206 gives aborted tasks their own cleanup hook.
These support independent cleanup ownership; none is an exact phone-receipt or
Rose report-overlay implementation. Their best-effort semantics are not used
to acknowledge unconfirmed physical release.

## Solution

Task finalization defers the physical cleanup exception until independent local
collector teardown and fixture/env restoration have run. An existing ERROR (or
cancellation result) retains its original failure, gains the physical cleanup
diagnostic, remains ERROR, and is republished. Without such an error result the
physical cleanup exception still raises. No success can bypass physical proof.
The cleanup-completed counter remains unchanged on failure; the existing
final receipt publisher consequently writes failed, retaining the isolated DB.

Main finalization joins its owned report ticker, transfers unconsumed evaluated
occurrences into saved results, then clears the overlay. An active exceptional
exit forces such retained occurrences to ERROR while keeping their original
failure detail. Parallel cancellation consumes each overlay exactly once;
an interrupted finalization cannot turn an earlier provisional PASS into PASS.
No later physical recovery rewrites the original failed attempt into success.

Delete/unify/guard: remove the destructive overlay-clear-before-transfer and
reuse the existing task result and receipt authorities. Do not add another
cleanup acknowledgment or globally cancel tasks. Local collector stop remains
owned by the existing bounded join helper, with no timeout changes.

Commands from agents with the venv activated:
`python -m pytest -q benchmarks/phone_connectivity_test.py -k failed_phone_cleanup`
failed both synthetic modes before the task fix (1.56s), then passed unchanged
(0.62s). Modes retain an original PhoneCleanupBlocked and a distinct execution
failure, inject a later blocked cleanup, run real owned asyncio collector tasks,
assert both collectors done before return, preserve a foreign task, keep the
exact synthetic root, forbid deletion, and assert started=1/completed=0 plus
state=failed in a temporary token-owned receipt. Test teardown reaps only its
own synthetic async tasks even on red. No live API/provider or process signals.

The real report/coordinator AST harness already in benchmark.blackbox.py is
reused for test_failed_task_finally_preserves_published_error_in_terminal_report.
It executes the actual finalizer prefix, fails with published ERROR reverted
to queued during finalization, then passes unchanged. Exact red/green command:
activate the agents venv, run Python importing asyncio/runpy/sys, insert
`tests/blackbox` into sys.path, runpy.run_path the existing benchmark.blackbox.py,
then asyncio.run the named case:

```bash
cd agents
source venv/bin/activate
python - <<'PYTHON'
import asyncio, runpy, sys
sys.path.insert(0,'tests/blackbox')
suite=runpy.run_path('tests/blackbox/benchmark.blackbox.py')
asyncio.run(suite['test_failed_task_finally_preserves_published_error_in_terminal_report']())
PYTHON
```

The initial missing-path/dotted-pytest import
attempts were harness invocation errors, not causal red evidence; the preserved
before log contains the subsequent genuine assertion failure.

The existing recurring phone test discovery registers the two parameter modes
through _with_pytest_fixtures; the report regression is registered with
record_async. benchmark-lifecycle-registered.log records execution through
BlackboxResult, the existing pytest wrapper, and both neighboring admission /
repeated-occurrence controls. The additional interruption control ensures an
early provisional success becomes exactly one ERROR occurrence after task
finalization is interrupted, preserving its root identity. Full phone offline module: 27 passed in 1.72s.
Ruff and diff whitespace checks cover the three assigned changed Python files.

10k-agent behavior: only occurrence-owned result transfer and existing collector
joins; no new channels, subscriptions, database queries, polling, global secret
state or cross-agent cleanup. Final transfer costs O(outstanding evaluated
occurrences) once at run shutdown. No hot-path O(fleet-size) work was added.
No 10k-concurrency load claim is made.

Scope: source-only fix, synthetic owning-boundary proof; the unchanged native
canonical task was not rerun. Runtime/backend provider recovery and a fresh
canonical run remain with the parent and sibling owners. Source edits cannot
reload the original controller. Parent owns archive reindex. User's no-spawn
instruction prevents an independent subagent RCA review; tests and local diff
review are the review performed here.

## Human feedback

User required preserving the original failed attempt and failed/pending recovery
authority, no live provider actions, process signals, runtime/backend edits,
criteria/prompt/timeout changes, commit/deploy/spawn, or restarting the original.
User corrected the evidence scope: top-level collectors stopped naturally;
prove task-finally teardown independently and diagnose ERROR-to-queued from the
actual publication path. Freedom and AGENTS remain untouched.

## Reusable lesson

Transfer terminal occurrence evidence before clearing reporting overlays and retire independent owned collectors even when physical resource cleanup fails.
