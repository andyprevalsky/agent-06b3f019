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
  - benchmark run 75a7f70a-71c5-4929-87d9-6e772ae450d7
  - agent b53db629-4b68-4d7a-b763-1777d3b15f45
  - commit 379cd490cf75ec87fa4cfbbc179f0222c429ee8d
repro: agents/benchmarks/phone_connectivity_test.py:test_failed_phone_cleanup_drains_owned_collectors_and_preserves_error
status: fixed
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
reload the original controller. Parent owns archive reindex. The delegated
worker did not spawn a further reviewer; tests and parent diff review are the
review performed here.

## Unchanged canonical outcome verification — 2026-10-18

The prior OPEN handoff statements above describe the evidence available then;
the unchanged native outcome gate is now closed. Parent ran the normal command
`bash scripts/run-bench --local browser-cloud-iphone-settings --run-id phone-connectivity-20261018t2042-r2 --no-dashboard`
at checkpoint `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`. Its native controller
exited 0. Native run
`agents/benchmarks/runs/20261018_204540_75a7f70a-71c5-4929-87d9-6e772ae450d7_browser-cloud-iphone-settings.json`
records **PASSED**, COMPLETED, score 1, 177.3 seconds, 51 messages, and no failure.
The FINISHED canonical completion card reports typed `visible_heading` =
`Paired Computers`; the strict persisted launch/OCR/heading and no-attention
checks passed. This is actual Rose/cloud-phone evidence, not a replay verdict.

Original trigger: `2026-10-18T20:06:57.416731+00:00`; third-attempt trigger:
`2026-10-18T20:41:34.224899+00:00`. Hub:
`75a7f70a-71c5-4929-87d9-6e772ae450d7`; root:
`b53db629-4b68-4d7a-b763-1777d3b15f45`. The original ERROR and second FAIL
remain failures; the third PASS does not rewrite either. The original
controller's finalizer lost its native completed run/ledger row. A source-tagged
ERROR row was appended to `history/task_attempts.jsonl`, preserving every prior
byte. Its 457-second duration is explicitly the rounded original report display,
not an invented exact tenth; timestamp comes from the original local Hub run.
No token counts were inferred. Backfill provenance:
`.context/phone-harness/goal4-close-history-backfill.json`.

`tasks.py` does not exist in this benchmark package; the authoritative
`agents/benchmarks/tasks.json` is byte-identical from `33bf65449502dd377dec57f576f8590bdb091d71`
through `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`, SHA256
`711a7f0f0e05db71042792751fbb7e1ad3c347285a943d0789a7cf93059363b8`.
All six recorded runtime hashes in
`.context/phone-harness/live-connectivity-retry2-slice.json` match both the pass
checkpoint and closure-time checkout. Verification receipt:
`.context/phone-harness/goal4-close-frozen-proof.json`. These are bug fixes under
unchanged task criteria, not a claim that all runtime files match the buggy revision.

Parent's retry log records cleanup `started=2 completed=2 state=clean`.
Both task and local-stack receipts are clean, and local-benchmark-owner state is
`cleanup_verified`. No resource stop acknowledgment substitutes for this proof.
The real canonical publisher completed; fresh-browser FE verification saw all
51 messages and retained browser termination/recording checks. The rendered dump
was published to HTTPS and its recorded readback returned 200. Exact verified
share/HTTPS links and canonical HTML are retained in
`/opt/cursor/artifacts/rca_evidence/b53db629-4b68-4d7a-b763-1777d3b15f45/manifest.json`;
publication log: `.context/phone-harness/live-pass-publication.log`.
Independent closure readback also returned HTTP 200 for the 39,048-byte HTML;
`.context/phone-harness/goal4-close-outcome-proof.json` records its hash, native
PASS/FAIL hashes and three preserved attempt rows without copying signed URLs.
The second attempt's separately published FAIL remains unchanged.

This closure ran no additional paid benchmark, live phone operation, deploy,
commit or process intervention. Goal 5 frontend work is independent of this
Goal 4 proof; it is not included in this result.

The existing failed-cleanup and report-finalizer red/green regressions remain
the causal proof. The real retry completed its normal terminal publication and
cleanup. The source-annotated historical ERROR backfill repairs evidence
coverage only; it does not fabricate a lost native JSON or alter its queued
report artifact, and later physical recovery never changes that ERROR.

## Human feedback

User required preserving the original failed attempt and failed/pending recovery
authority, no live provider actions, process signals, runtime/backend edits,
criteria/prompt/timeout changes, commit/deploy/spawn, or restarting the original.
User corrected the evidence scope: top-level collectors stopped naturally;
prove task-finally teardown independently and diagnose ERROR-to-queued from the
actual publication path. Freedom and AGENTS remain untouched.

## Reusable lesson

Transfer terminal occurrence evidence before clearing reporting overlays and retire independent owned collectors even when physical resource cleanup fails.

## Registered fixture follow-up: awaited report ticker

The full registered benchmark gate run
`20261018-225941-657459-737733b8` exposed a stale companion fixture while
validating the later phone rollout. Six variants of
`test_evaluated_wrapper_completion_publishes_once_before_owner_release` failed
before their publication assertions: the extracted real coordinator now awaits
its cancelled ticker, but this fixture supplied a cancel-only `SimpleNamespace`.
The actual runtime ticker is an asyncio task. No production finalizer failure
was inferred from the incomplete fixture.

The identical targeted command was run before and after fixture correction:
`cd agents && source venv/bin/activate && python -m pytest benchmarks/cloud_batch_cleanup_test.py -k test_evaluated_wrapper_completion_publishes_once_before_owner_release -q`.
It failed all six variants with `TypeError: unhashable type: types.SimpleNamespace`
in 6.57 seconds. The correction creates and starts a real task in the same event
loop, passes it to the unchanged coordinator, and requires the coordinator to
cancel, await and finalize that task. It preserves all existing publication,
owner release, exception, skipped and digest assertions. A subsequent missing
`sys` fixture binding was also corrected by supplying the real `bench.sys`.
There is no product, task, prompt, timeout or criteria change in this repair.

All six variants then passed the same command in 1.92 seconds. Logs are
`.context/phone-harness/ticker-fixture-red.log`, `ticker-fixture-green.log`
(the retained intermediate missing-global failure), and
`ticker-fixture-green2.log` (final pass). Ruff and diff checks pass. The parent
owns the full registered benchmark-domain rerun; its final result is recorded
with the rollout verification rather than substituting this focused pass.
The full registered `python scripts/run_blackbox_tests.py benchmark` rerun is
GREEN in 217.6 seconds, including this exact six-case wrapper regression.
Log: `.context/phone-harness/isolation-checker-normal-green.log`.

## Registered interrupt-fixture recurrence — November 8, 2026

The independent full agents gate on `0f23c8707` retained two Python failures
(182 passed): `test_interrupt_of_exclusive_serial_task_admits_no_queued_task`
and `test_interrupt_of_sequential_task_admits_no_queued_task`. Both reached
`asyncio.gather` with the interrupt fixture's cancel-only `SimpleNamespace`
instead of the real runtime ticker task. The unchanged companion fixture did
not represent the producer's already implemented cancel-and-await contract.
This is an introduced fixture integration defect, not a reason to remove the
producer's await or relax its terminal nonadmission assertions.

The exact two existing tests were copied without modification into an isolated
fixture scope against the actual `0f23c8707` producer. Under the canonical native
supervisor they reproduced both identical `TypeError` failures in 3.70 seconds.
Creating the ticker as a real task inside the scenario's running event loop,
then requiring it to be cancelled, made the identical command pass both tests
in 1.59 seconds. Every original queued-task, CANCELLED-row and nonadmission-proof
assertion and both ten-second bounds remain unchanged. No product, task,
provider, prompt, financial or production-environment behavior changed.

The original full native failure and both supervised owning runs are retained
under `.context/rca-google400/round54-final-source/ticker-fixture-owning/` and
`agents49-readonly-rca.json`. The full agents gate still requires ordinary final
source validation; this focused result grants no deploy or physical-phone credit.
The separate coordinator exit143 remains unattributed, with its original missing
outer receipts and native outcomes preserved by the negative-only recovery.

After canonical integration, the complete existing owning file passed all five
tests in 2.75 seconds under the native supervisor, with quiescent cleanup and
no orphans. The RCA archive validated all 1,625 cases. Normal final-source full
validation remains a separate required gate.
