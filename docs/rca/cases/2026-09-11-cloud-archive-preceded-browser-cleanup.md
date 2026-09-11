---
id: 2026-09-11-cloud-archive-preceded-browser-cleanup
date: 2026-09-11
title: Cloud evidence froze before recording cleanup and stack shutdown killed its writers
surface: cross
component: cloudbench-browser-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_benchmark.py archived a pre-cleanup transcript while run.sh could stop the backend before worker recording finalization
symptoms:
  - "Timed out waiting for browser terminal messages after pause; archiving latest snapshot anyway"
  - "has no correctly attached recording"
  - "guest cleanup acknowledged while exact Kernel browser GET returned 200"
tags:
  - cloudbench
  - browser-recording
  - teardown
  - worker-shutdown
  - ownership
sources:
  - PR #1299
  - fleet run 20260910-212223-85449
  - agent cee43eed-c9c5-4a64-95c1-9f409d3fd713
repro: agents/benchmarks/cloud_batch_cleanup_test.py
status: open
---

## Problem

The second slice of the five-minute validation had ten task outcomes and no
reported infrastructure failure, but durable evidence validation rejected the
Polar root `cee43eed-c9c5-4a64-95c1-9f409d3fd713`. Three browser tasks lacked an
attached finished recording. The published transcript contained 93 messages;
a later database fixture contained 96 and recovered only one missing recording.
An independent exact Kernel read found one of the remaining browsers still
rented after the guest had acknowledged cleanup. The exact owned browser was
subsequently released and an independent read returned 404. The validation
attempt was stopped; neither its resource recovery nor its two preliminary
infrastructure acceptances count as a successful ten-slice proof.

## Diagnosis

Two lifecycle boundaries were incorrectly treated as completion. The benchmark
captured messages before diagnostics and asynchronous recording finalization had
finished. A timeout only warned, allowing that earlier transcript into the run
bundle. Separately, stack teardown visited the backend before workers and sent
TERM throughout the worker process tree before a one-second hard kill. A worker
receiving its second shutdown signal intentionally exits quickly, bypassing its
normal recording drain. Thus process exit alone did not establish provider or
recording cleanup.

A subprocess reproduction ran the actual stack cleanup function against a
worker whose delayed cleanup required a live backend. Before the fix the worker
was killed, its cleanup marker was absent, and the backend had already exited.
The permanent regression uses a real HTTP request to the still-running backend,
so a zombie PID cannot satisfy the assertion. Another exact fixture reproduced
an owned snapshot being removed before the volume-migration audit's last read;
that recurrence is recorded in the existing migration case.

Archive search found the August 31 FE recording validation case. That publisher
check worked here: it exposed the incomplete run instead of approving it. The
new cause is producer/archive/shutdown ordering, not missing publisher checks.

## Solution

The local worker launcher has one signal-owning supervisor. Each direct worker
receives at most one cancellation signal and retains its existing graceful
shutdown and recording-finalization bounds. Stack teardown drains workers while
the backend/database remain available. A failed but reaped worker still causes
the remaining owned services to be removed; the terminal receipt remains failed.
A still-unproven worker leaves recovery authority intact. Stack receipts bind the
run token and the actual stack PID and birth time.

Owned local cloud batches defer archive sealing until every selected task has
returned. Workers remain available, preserving the existing mandatory autoscaler
lifecycle. The batch pauses known roots, refreshes all expected root and child
transcripts under one bounded 60-second evidence window, and requires every
browser to be terminal with a recording attachment, including browsers that never
emitted a recording row. It then archives, canonically deletes the root, verifies
that every descendant is sealed, releases exact database-bound provider sessions,
and rejects any tree/session drift in the final read. A provider failure does not
skip the other sessions or other roots. Unknown creation outcomes and incomplete
evidence keep the cleanup verdict failed. No artificial recordings or terminal
messages are created.

Independent review reproduced two additional failures: one provider rejection
skipped another session under the same root, and a nonzero worker exit left other
stack services running. Both have permanent behavioral tests and were repaired.
The ten focused batch regressions and fourteen worker blackbox checks pass.
The complete benchmark blackbox group also passes. Linux controller validation
found two stale integration fixtures (missing newly required stack receipt/env
and a test runner bypassing batch finalization); both were updated to exercise the
actual contract, and the fifteen affected Linux cases pass. Live Polar replay and
the complete ten-slice proof remain required, so this case is still open.

At 10,000 agents, additional reads and provider releases remain bounded to the
exact benchmark-owned tree. Transcript reads use asynchronous concurrency;
provider operations visit each exact session once. There is no global provider
inventory or shared production database cleanup.

## Human feedback

The user required completion without permission prompts, ten consecutive
sequential cloud slices of ten real tasks with zero infrastructure issues, and
normal large execution backstops around 120 minutes. This validation temporarily
uses a five-minute execution limit. The limit does not replace recording or
provider teardown checks. After completion, explain current deploy benchmark
selection and a proposal for one global twenty-benchmark deploy budget.

## Reusable lesson

Keep recording writers and their backend alive until terminal evidence is captured, and require exact provider cleanup before acknowledging teardown.

## Recurrence: attempt nine, slice two

Slice one of `capability-stability-20260911055658-53991` produced ten task
outcomes, zero infrastructure errors, ten validated durable evidence bundles and
verified teardown. Slice two failed and does not count. Five of Polar's six
browser activities persisted recordings; the sixth continued work after the
root pause and did not finish recording before the existing 60-second archive
barrier. Investigation of that cancellation boundary remains open.

A second failure in exact Steel verification overwrote the first failure reason.
The TimeoutError also formatted as an empty string. Shutdown dropped the local
database, and neither pre-delete nor terminal ownership query was retained in
the failed task. Full backend and all eight worker logs were recovered from the
retained exact VM before destruction. The separate REST client identity issue
is recorded in `2026-09-11-exact-provider-client-identity-filtered`.

The batch now retains its exact before/after/final ownership snapshots and every
successful provider receipt in diagnostic evidence, including failed cleanup.
It records archive and provider errors separately and gives otherwise-empty
exceptions their type name. Only successful verification produces the existing
`cloud_provider_cleanup` success receipt. Diagnostics are not cleanup authority
and do not turn a failed run into a verified one.

The permanent blackbox reproduction
`test_failed_batch_retains_ownership_and_each_failure_cause` failed on the old
code because the ownership evidence was absent and the archive failure was
overwritten. It passes after the repair. A separate added helper contract test
asserts terminal snapshots and earlier provider successes survive a later
release failure; its initial run encountered the newly required keyword before
implementation, so that initial TypeError is not claimed as causal evidence.
All thirteen focused cleanup tests pass, and the full benchmark blackbox group
passes in 60.0 seconds. Those results do not establish the live recording fix;
no ten-slice acceptance claim is made from them.

The preserved Temporal history subsequently confirmed cancellation requests for
all six browser activities at 06:32:01.823Z. Activity 35, browser task
`563dfc20-1b9a-50c3-9ea3-75e056fb81fa`, continued work across the final evidence
window and never completed before root termination. The retained logs do not
identify the exact await where its cancellation delivery was consumed.

Pinned Python 3.11.9 and Temporal's real ActivityEnvironment provide a
deterministic owning-boundary reproduction: complete the inner page-state future
and request cancellation in the same event-loop turn while the activity awaits
`asyncio.wait_for`. The await returns with Temporal's cancellation flag still
true. A plain heartbeat succeeds, allowing another paid work step. A heartbeat
is a liveness signal, not a cancellation checkpoint.

The first refactor moved the existing explicit work heartbeats into one helper
without changing behavior. The permanent test then failed with
`['paid-step', 'recording-saved']` instead of cancellation followed by cleanup.
The shared work checkpoint now checks Temporal's persistent cancellation state
and raises CancelledError into the existing cancellation/finally path. The same
test passes, proves normal work still runs without cancellation, and proves an
awaited cleanup and cleanup heartbeat remain possible. The process heartbeat
pump and recording cleanup do not perform this work check; repeatedly cancelling
them would recreate the earlier lost-recording bug. No timeout was increased.

The permanent browser blackbox also replays an unacknowledged recording-message
save. Before the repair, both finalizer paths could report success despite the
backend returning false (the live missing browser received HTTP 404). Kernel
and frame finalizers now require acknowledgement; frame artifacts are retained
when persistence fails. The valid before run failed because no error was raised;
the same assertion passes after the repair. An earlier fixture invocation with
a missing tempfile import is retained as an invalid test setup, not causal proof.

Local reproduction commands:

- `agents/venv/bin/python .context/setup/run-browser-cancel-repro.py`
- `agents/venv/bin/python .context/setup/run-recording-ack-repro.py`

Both call permanent tests in `spawn_browser_agent_v3.blackbox.py`, registered in
that domain's standard blackbox runner. Existing fixtures that directly call
activity-bound code now run inside ActivityEnvironment, rather than bypassing
production cancellation checks. The initial full Mac run also exposed missing
Playwright Chromium binaries; those were installed before the valid full rerun.

Canonical recovery reconciled all ten retained slice-two machines. Independent
provider reads verified all ten machines terminal, all ten volumes terminal and
unattached or exactly absent, and the ownership registry absent. A separate
exact Steel GET verified its released state; the older recovery log parser had
only recovered the six Kernel identities. Recovery is not retroactive slice
acceptance. The ten-by-ten proof must restart after live verification of this fix.

Recovery now unions log-derived sessions with the exact before/after/final
ownership snapshots in the sealed run JSON. It checks the run digest again
before reading those snapshots, validates every root/tree/provider/session
binding, supports a snapshot-only provider identity, and rejects malformed
present evidence. Older runs with no snapshot field retain their existing
log-based path. Positive snapshots also forbid the zero-allocation alternate
receipt. The permanent recovery regression failed before the change with an
empty Steel set and passes afterward, including snapshot-only and malformed
identity cases. Four canonical recovery integration cases pass. Independent
review identified and verified the digest, present-null and zero-allocation
consistency checks.

The second full browser blackbox run passed all checks except one token-rotation
fixture still missing ActivityEnvironment. That failed subset passes after its
context correction. The fourteen cleanup regressions and the previously run
eighteen execution-backstop regressions pass. Live task verification remains
required, and this incident remains open.
