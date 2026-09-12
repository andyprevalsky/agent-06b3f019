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

## Recurrence: attempt fourteen — cancellation delivery and retained diagnostics

Proof `capability-stability-20260911204913-52338` stopped at its first slice.
Nine roots produced ordinary PASSED/FAILED outcomes and durable evidence; root
`d8b57dcc-ed76-4309-8821-44fa3ca4babd` produced ERROR with
`Cloud evidence finalization failed: TimeoutError`. Zero slices are accepted.
Independent reads subsequently verified all ten machines, eleven volumes and
nine unique Kernel sessions terminal. Cleanup does not retroactively accept the
failed slice. The source was `140bb417ce07636ee17a743df5aca7953e597673` and every
actual root used the authorized 300-second backstop.

Temporal history records cancellation requests for all four browser activities
at 21:20:39.115 UTC. Two returned cancelled at 21:21:58.617 and 21:22:39.521;
two had no terminal activity event before workflow termination at 21:23:01.822.
The activity cancellation log at 21:21:28.616 belongs to browser `33cafd97`
by its span ID; adjacent log ordering had initially suggested the wrong browser.
Backend logs record one successful native recording message at 21:22:00.852
and three later attempts receiving 404 after deletion. Thus recordings were
late, rather than all four finalizers never starting. The retained worker
snapshot ended at 21:21:37, and a canonical ClickHouse query returned no later
rows. Neither workflow cancellation requests nor eventual activity returns
identify the exact live SDK delivery instant or the await that consumed it.
The live missing-recording attribution remains open.

Two independent, local causal reductions now cover cancellation boundaries:

- Actual nested recovery with Temporal ActivityEnvironment continued through
  focus, Escape, button lookup, reload and message save after a completed
  `asyncio.wait_for` lost simultaneous Task.cancel. The permanent browser
  blackbox reproduces cancellation at five separate work awaits, with normal
  and pending-cancel controls. `wait_for_browser_work` now checks the persistent
  cancellation latch on every exit, including a concurrent timeout. Only the
  eight recovery work waits use it; recording/resource cleanup retains its
  existing cancellation behavior and all timeout values. The unchanged owning
  test failed before and passed afterward; the full browser domain passed in
  38.0 seconds. Independent replay also verified normal errors and timeouts.
- The actual native Temporal Worker batched the existing 15-second application
  heartbeats behind its default 60-second transport throttle. A strict local
  gRPC service returned `cancel_requested` only in a real heartbeat response;
  no test injected Task.cancel. The permanent test reads the production Worker
  heartbeat expression, or the actual SDK default when omitted, and requires
  delivery within the existing cadence plus five seconds. It failed at
  60.015474 seconds before the change and passed at 15.006745 seconds afterward.
  Normal completion and awaited cleanup/shutdown controls also passed. The
  production worker now caps transport batching at that existing 15-second
  cadence. This is not a 15-second end-to-end recording guarantee. The test is
  registered in the owning worker blackbox and therefore in `/deploy`.

The new native fixture also observed the existing thread heartbeat fallback
creating an unawaited SDK coroutine before retrying on the activity loop. That
is a separately retained limitation: the thread alone cannot guarantee native
RPC progress while the SDK activity loop is blocked. It is not assigned as the
cause of this incident. The earlier thread-only fake callback test did not prove
that stronger claim. Initial independent fixture attempts missing legitimate
DescribeNamespace/ShutdownWorker RPC handlers are retained as invalid fixture
setup and excluded from causal evidence.

The archive and controller now retain the missing diagnostic boundaries. A
failed final archive read preserves its last full tree observation, timestamp,
and unready state separately from publishable messages. Success removes that
unready observation. Failed batches refresh exact-root local worker logs after
provider release, preserving earlier logs and recording capture errors without
changing the cleanup verdict. Permanent tests failed on missing observations
and late worker rows before the change; the same tests pass afterward and all
21 batch cases pass. Independent review found that a busy worker could exhaust
the old prefix reader before later cleanup in another worker file. The new
permanent finalizer regression failed in 0.40 seconds after 20,000 earlier rows
hid the late worker.3 recording line. The unchanged test passes with late events
in either worker.0 or worker.3. Failure diagnostics now retain the newest
20,000 matching lines across files by structured timestamp, using file mtime
and stable line order for unstructured text. Default prefix reads stay unchanged;
prior evidence is preserved, so two capped captures can retain up to 40,000
diagnostic lines. This is separate from the acceptance transcript. Reader
controls cover timestamp/time fields, naive timestamps, invalid/unstructured
lines, time windows, default ordering and the cap. A second independent review
reproduced a moving-EOF read: a producer extended a five-row file while the
reader consumed fifty rows without returning. The permanent UTF-8 actual-file
regression failed in 0.42 seconds before the fix and passes unchanged afterward.
Newest reads now snapshot each opened file size and read only that many bytes;
appends cannot prolong awaited cleanup. The heap remains capped at 20,000 rows.

The controller had separately rejected its final log reads with
`bench.log could not be read after 5 bounded retries`. Its validated prefix was
intact, and a separate exact data-plane tail contained DONE; the discarded
transport/protocol metadata prevents a more specific historical attribution.
The reader now retains at most twenty failure records containing offset, curl
exit, status, byte count and the allowlisted range/generation headers. It never
commits a failed response body, stores credentials, acknowledges cleanup, or
changes retries. The actual partial-response/wrong-offset regression failed
before metadata retention and passes afterward; the 16.34 MB terminal catch-up
control also passes.

At 10,000 active activities the throttle change permits approximately 667
periodic heartbeat RPCs per second instead of 167 when the old maximum was
binding; it adds no per-agent threads, connections or shared fan-in. The
persistent cancellation check is constant local work per recovery await.
Diagnostic capture is bounded to the exact run/tree and the existing local log
reader limit; controller failure history is capped at twenty records.

The unchanged pre-fix local benchmark ran from isolated worktree
`rose-pr1299-rca14-baseline` at 140bb417c, using
`scripts/run-bench --local polar-odysseys-4246dec196c9 --run-id proof14-baseline-local`
and the authorized 300-second root backstop. Root
`70dbce76-4d16-4503-b1bb-8b7c962a857c` returned ordinary FAILED after the
backstop (one browser had only one trajectory step); all four recordings were
attached. Thus the exact cloud archive ERROR did not reproduce locally; the
outcome-reproduction gap remains open. Independent provider reads confirmed
all four sessions returned 404, all owned processes were absent, and the exact
DB container and volume were removed. Canonical publication verified the
[durable FE](https://www.roselabs.ai/?agent-id=70dbce76-4d16-4503-b1bb-8b7c962a857c)
and rendered the final root LLM dump. The native worker blackbox passed all
17 checks in 41.3 seconds, including the real-SDK cancellation regression.
The fixed local run used the same task and 300-second backstop. Root
`7d0687bf-a5b9-4639-9501-56d06948362d` produced ordinary FAILED (timeout),
with its browser terminated and recording attached. Canonical publication
verified its durable FE and final LLM dump, and independent checks verified
the exact browser session, processes and database absent. A nonfatal SSL error
in the runner's Hub mirror attempt is retained; canonical publication then
succeeded, so no missing evidence is treated as acceptable. The run is not
proof of capability completion or of the original cloud ERROR's cause. Its
scratch observer exited143 after cleanup; the separate local cleanup argv-match
RCA records that new owning-boundary defect. Full gates on the final source and
a fresh ten-by-ten cloud proof remain required. The prior thirteen passing prerequisite gates applied
to 140bb417c and do not certify these subsequent changes. Normal 7200-second
root backstops, the temporary 300-second validation limit, recording readiness,
provider ownership, and all cleanup/infra rejection criteria remain unchanged.

## Recurrence: local controller bypassed the cleanup owner

During the September 12 Group 4 validation on `99c3f978`, the parent monitor
mistakenly treated metrics warnings and zero billed cost as a stalled run.
The complete worker logs instead showed continuing LLM calls and browser work.
The parent sent TERM to its two isolated local controllers. This interruption
is not a model or benchmark capability failure, and neither run has an accepted
terminal benchmark outcome.

The interruption exposed a separate ownership defect: `local.py` immediately
stopped the stack without signaling and joining its benchmark child. Its
process-group shutdown also bypassed the existing worker-drain owner. In the
payment run, an already admitted mint completed after the backend shutdown had
started, leaving a held card and captured funding outside the removed database.
The prior stack-order regression exercised `run.sh` directly; it did not
exercise the outer local controller that could bypass that protection.

The actual-process reproduction used a real child and HTTP compensation call.
On the buggy source, TERM and INT left that child live with no DELETE request,
while direct stack shutdown preserved cleanup ordering. Calling the old
`local.stop_services` stopped the backend before the worker's HTTP cleanup and
ignored a failed cleanup receipt. Exact fixture-owned processes were reaped
after every case. These controls distinguish the broken owner from the already
correct inner shutdown path. Permanent tests in `local_lifecycle_test.py` are
registered in the existing benchmark blackbox domain.

The standard isolated local runner now owns the benchmark child, forwards one
cancellation signal, joins its finalization, and then signals the exact stack
owner. Stack token, PID and native birth identity bind the cleanup receipt;
missing, pending or failed evidence cannot be reported as verified. The local
runner uses the same owned-batch finalizer as cloud execution. Explicit paused
checkpoint and independent eval runner semantics are not claimed to be covered
by this standard-runner repair.

Independent review reproduced a second cancellation boundary after stdout EOF:
the child closed its output, then the controller received TERM while an
unbounded process wait was already active. With the shutdown budget injected
as 0.2 seconds, the permanent control failed after 1.225 seconds on the first
candidate. Polling the existing deadline after EOF makes the unchanged test
pass; the independent original replay returned in 0.442 seconds. No production
deadline changed. Another permanent actual-child control failed when a refused
owner-journal write lost the child handle before the caller received it. The
handle is now published before fallible identity/journal capture, while signal
deferral ends only after that capture attempt. A capture-time interruption
control also failed when it used a previous child's native identity; delivery
now waits for the new identity and occurs once. Unverified journal/identity or
receipt evidence retains authority rather than guessing a process or DB name.

The seven local lifecycle tests pass in 4.63 seconds. They cover real TERM/INT
forwarding, child joins, backend-dependent cleanup, an unrelated live sentinel,
missing/wrong/pending root receipts, repeated interruption, startup rollback,
EOF cancellation, publication failure, native-identity publication, and stack
receipt identity/error controls. Ten adapted legacy setup tests also pass;
mock setup tests stub only native capture, while the actual owner fixture proves
retirement ordering and sibling survival. The former DB-name fallback assertion
now requires refusal without any Docker command when stack authority is absent.
The recurring benchmark blackbox discovers every new local control and keeps
the real startup owner case registered through its existing startup entry.

Remaining alternate-mode ownership is an explicit open follow-up:
`run_eval_suite_invocation` still uses `subprocess.run`, and checkpoint creation
and polling still use `run_streamed_command`, outside `LocalBenchmarkOwner`.
Their interruption paths need their own exact-root capture, child join and
cleanup-receipt regressions before they can claim this same guarantee. That
contract must distinguish deliberately paused checkpoint roots, preserve
`--checkpoint-no-start`, and leave `--use-existing` dependencies owned by their
caller. The current repair does not silently delete those paused roots or
claim that those alternate controllers are now cancellation-safe.

Payment verification is now a separate obligation within that finalizer. Its
exact sealed-tree query includes purchase and wallet-funding rows. Admitted
mint work must become visible before external effects and remains pending until
canonical compensation reaches confirmed terminal states. The permanent
late-mint reproduction failed before the change because cleanup reported
success with a HELD card; the unchanged test passes after compensation. A failed
refund remains a failed cleanup. Malformed payment evidence fails payment
verification without hiding independently valid browser-release authority.
That independence test also failed before its correction and passes afterward.
All 23 batch cleanup tests pass in 1.76 seconds.

Stripe refund creation itself is only an acknowledgement: its status can be
pending, requires_action, failed, canceled or null. The permanent
`purchases.refund-completion` blackbox observed six failures and one positive
control before the repair, then seven passes unchanged. Canonical compensation
retains the same purchase-scoped idempotency key, retrieves the exact refund
when a cached acknowledgement is not succeeded, and returns only after
confirmed success. Otherwise existing retryable payment states retain the
obligation. Purchase admission and stale reversal have additional backend
owning-boundary regressions and a separate related RCA.

Recovery of this interrupted run is independently verified: both exact Temporal
runs were terminated, both native Kernel recordings were preserved before
deletion, and both exact session reads then returned 404. The one owned payment
card is closed with zero balance; its wallet funding was reclaimed and its
4,396-cent test payment fully refunded. The exact newly created test payment
method and customer were removed. The pre-existing shared cardholder was left
unchanged. The owned local processes, database containers and volumes are
absent. Private receipts are under
`.context/acceptance/group4-temporal-rate-limit-rca/`; they contain no authority
to alter another run's resources.

At 10,000 agents, purchase admission uses the existing per-agent generation
lock only during a short database transaction, never during provider I/O.
Cleanup reads and actions are scoped to the owned tree, use the existing
180-second payment boundary, and retain one purchase-ID set per finalizing
batch. Refund verification adds at most one exact provider read per canonical
attempt and no global scans, shared counters or new polling service.

These causal regressions do not certify the live acceptance gate. The prior
thirteen prerequisites apply only to `99c3f978`; this changed source requires
fresh full validation. Zero slices are accepted. Proof fifteen allocated no
task resources because the protected shared warm source remained busy; proof
sixteen has not launched. This case stays open pending the required live proof.
