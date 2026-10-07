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
  - fleet run 20260928-131153-24839
  - agent 9a9283c8-b72e-4b0f-914e-f82f0dfd08af
  - fleet run 20261003-022837-17288
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

### 2026-10-01 review recurrence: failed receipt publication and reaping

CodeRabbit findings 4151506600 and 4151506729 identified two missed terminal
failure paths. The permanent worker blackbox reproduced both on unchanged
runtime. The local supervisor called `wait()` without a bound after issuing
SIGKILL; a simulated unreaped native child rejected that unbounded wait in
0.04 seconds. Its unchanged test passes in 0.01 seconds with a shared five-second
reap deadline, using the existing outer shutdown-timeout margin. A timeout still
fails the supervisor; signalling is never promoted into proof of process exit.

The real Bash stack fixture then made the pending receipt's parent directory
unavailable. Before the fix, `cleanup` returned before draining its worker or
stopping the actual owned backend, reproducing the leak in 2.17 seconds. The
identical test passes in 3.46 seconds: the worker finishes its delayed HTTP
cleanup while the backend remains alive, the backend is reaped, and the receipt
failure still returns nonzero. The only runtime change records that initial
publication failure and continues the already-owned teardown. No missing
receipt is synthesized, and failed cleanup never receives acceptance credit.

A stricter version of the same fixture then invoked `cleanup` directly under
`set -e` and combined worker failure with receipt failure. It exposed another
unguarded failed-receipt publication before backend teardown: RED in 6.50 seconds.
Guarding that publication preserves the recorded cleanup failure while allowing
owned teardown to finish. Both zero and nonzero worker exits are retained in the
final fixture. The final terminal receipt failure still returns nonzero.

The previous tests covered worker errors and receipt success, but omitted the
status sink itself failing and native reaping remaining incomplete after kill.
Both regressions are registered in `agents/tests/blackbox/worker.blackbox.py` as
`test_local_worker_supervisor_bounds_reaping_after_kill` and
`test_stack_reaps_services_when_pending_receipt_cannot_be_written`. Private
RED/GREEN receipts are `.context/acceptance/proof84-worker-review-{red,green}.receipt.json`.
Archive searches were `Worker shutdown pending metrics poller` and `supervisor
teardown receipt cleanup signal`. All state is per owned worker or stack; no
per-agent requests, shared locks or live verification stage are added. Live
fleet outcome proof remains outstanding.


### 2026-10-03 recurrence: optional archive failure retained released ownership

The current infrastructure campaign uses the user's revised contract: meaningful
provider execution, a genuine terminal PASSED or FAILED outcome, and exact owned
resource retirement within 1,800 seconds. Archive and publication failures are
warnings. The previous finalizer still combined archive failures with mandatory
cleanup failures, overwrote the task's FAILED verdict with ERROR, and raised before
the guest completion acknowledgment. Its earlier regressions explicitly blessed
that obsolete coupling, so the changed policy had not reached its owning boundary.

Run `20261003-022837-17288` captured one archive TimeoutError at browser readiness.
Its original exact cleanup evidence established a sealed/deleted root, one provider
release receipt and zero purchases; no provider or payment failure was recorded.
The finalizer nevertheless raised, the task result was not collected, and native
observations showed all ten pool Machines started with ten claims and one owner
registry. This was a real retained-resource failure, not a task verdict to waive.
Canonical exact-owner recovery subsequently verified all ten stopped with their
original volumes, zero claims/registry and all eleven recorded process owners
absent. Recovery grants zero acceptance credit; original artifacts remain private.

Archive searches used `owned-cloud evidence finalization TimeoutError cleanup
acknowledgement` and `browser archive readiness root timed out recording terminal`.
This is a recurrence at the same finalization/acknowledgment boundary. The deepest
owned cause is a contract that gave optional artifact production authority over
mandatory resource release. The repair removes that authority rather than raising
a timeout or fabricating a recording, result or cleanup receipt.

The permanent owning test
`test_archive_warning_preserves_terminal_result_and_exact_cleanup` ran unchanged:
`cd agents && source venv/bin/activate && python -m pytest
benchmarks/cloud_batch_cleanup_test.py -q -k
archive_warning_preserves_terminal_result_and_exact_cleanup`. Before the repair
it failed with the finalizer's archive RuntimeError in 0.84 seconds; afterward it
passed in 0.59 seconds. It covers timeout and missing manifest, PASSED and FAILED
verdict/reason preservation, exact once-only resource callbacks and late logs.
The existing cleanup suite's 32 cases passed in 1.89 seconds, retaining hard
provider/payment/tree/owner/cancellation controls and adding a missing-result
control. An old four-arm fixture also required its current `require_deleted`
callback contract; its initial fixture failure is preserved and is not causal
evidence. Both added cases are auto-registered by the existing benchmark deploy
domain; there is no new live stage or large verification suite.

The finalizer now records artifact failures separately as warnings, preserves
terminal task grading and returns only after authoritative resource cleanup.
A failed pause acknowledgment with an established exact snapshot can recover
through the same later sealed-tree/provider/payment proof. Missing task results,
unknown ownership, owner/session drift, unsealed descendants, unresolved payments
and provider rejection remain hard. Cancellation still propagates and restores
the exact owner context. At 10,000 agents the change adds no network request,
shared admission lock or global inventory; it changes classification only within
each existing owned finalization operation.

The archive timeout's underlying readiness cause and the exact unchanged local
benchmark outcome reproduction remain open. The causal owning test does not
establish a new successful fleet slice or resolve the original live OOM. This
case remains open pending actual outcome and campaign proof.

## Human feedback

The user required completion without permission prompts, ten consecutive
sequential cloud slices of ten real tasks with zero infrastructure issues, and
normal large execution backstops around 120 minutes. This validation temporarily
uses a five-minute execution limit. The limit does not replace recording or
provider teardown checks. After completion, explain current deploy benchmark
selection and a proposal for one global twenty-benchmark deploy budget.

For this recurrence the user explicitly requested the practical terminal/result
and exact-resource E2E gate, warning-only recovered/intermediate errors, no speed
reviews, no unnecessary resets or reruns, and quick owning tests cemented in the
existing deploy process without adding a massive verification suite.

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

## Recurrence: proof 23 stalled before recording cleanup

Proof `capability-stability-20260928131153-24802` ran ten real tasks in its
first slice on `474d5ae5f72fea35ada058388e02afcd8adda7d4`. Nine roots had
ordinary task outcomes and complete evidence. Root
`9a9283c8-b72e-4b0f-914e-f82f0dfd08af` reached the 300-second test
backstop, but one of its four browser tasks had an ERROR terminal with an
IN_PROGRESS recording and no attached playback. The archive refresh rejected
it with `Cloud evidence finalization failed: TimeoutError`. The other three
browser tasks attached their recordings. This attempt has zero accepted slices.

The retained worker log places cancellation of the affected activity at
13:25:13 UTC. Cursor broadcasting continued for more than 80 seconds. Neither
`Browser cleanup started in background` nor a finished recording appeared for
that task before the archive's 60-second readiness bound elapsed at 13:26:31.
The activity's cancellation handler performs passkey capture and CDP disconnect
before its `finally` schedules recording cleanup; those awaits had no bound.
This is a producer-side recurrence of the missing-recording symptom. The
archive's fail-closed check was correct and was not relaxed. The exact original
guest volume was forked inertly; its bench, stack, backend, worker, and run
files were SHA-256 archived before retiring the failed fleet's resources.

Local owning-boundary reproduction:
`agents/venv/bin/python .context/setup/repro-browser-terminal-disconnect.py`.
Before the repair it failed after 10.39 seconds with
`AssertionError: ['passkey_captured', 'disconnect_started']`; the terminal
disconnect held the activity. The identical command now reports
`PASS bounded terminal disconnect: 0.052s`. The shared terminal I/O helper
bounds both passkey capture and CDP disconnect, including operations that
ignore cancellation. The background cleanup's own CDP disconnect uses the
same bound after recording publication. The permanent
`terminal_disconnect_stall_does_not_block_recording_cleanup` browser blackbox
simulates cancellation-resistant CDP I/O; the full browser blackbox suite
exited zero. No task definition, prompt, model, evaluator, recording readiness
rule, or benchmark timeout changed.

This causal test does not establish the exact benchmark outcome or a ten-slice
cloud acceptance. A fresh unchanged cloud fleet run from the repaired source
remains required, so the case stays open.

## Recurrence: premature operator stack cancellation, October 1

The invalid local AgentCard gate `98db495d-3941-4c31-ab68-06416ec5a4a9`
inherited the trace-disable setting documented in
`2026-09-30-semantic-trace-disable-inherited-by-local-benchmark`. Two completed
payment tasks failed durable finalization. During cancellation, the operator
sent TERM to the owned stack supervisor before signalling the benchmark owner.
That bypassed the benchmark owner's drain order. Normal stack cleanup removed
the owned PostgreSQL container and volume before the third task's canonical
root/payment cleanup could finish. This recurrence is an operator sequencing
error; it does not establish a regression in the normal owner shutdown path.

Two archive searches covered payment cleanup after database removal and lost
isolated-database card reclaim/refund ownership. They identified this existing
writer/stack-ordering case. Retained run records, sealed backend/worker logs,
the exact native stack receipt, and fresh process/container/volume observations
confirm the original resources and their loss. No original SQL fence succeeded,
and the interrupted task's missing lifecycle snapshot cannot establish one.

Recovery used only recorded root and provider identifiers. Fresh Temporal
descriptions bound each captured workflow/run to the original task queue: two
were completed, and the remaining exact running execution was terminated and
then verified terminal. Exact GETs for all three recorded Kernel sessions
returned 404 before and after recovery. Both completed purchases' exact sandbox
Stripe intents were succeeded with zero capturable funds and matching root and
purchase metadata; both exact AgentCard cards were closed with zero balance.
Their retained, linked transfer records were consumed. AgentCard capability
discovery exposes only `list_transfers(status, limit)`, so no fresh exact transfer
read was available; recovery did not substitute a broad organization inventory.
The interrupted root had no payment operation in its retained correlated logs
and zero intents in a complete exact-root Stripe metadata query. Those provider
observations do not replace the lost SQL fence.

Private receipt `.context/acceptance/payment84-exact-recovery/recovery.receipt.private.json`
binds the source artifacts and all observations by SHA-256. No card, transfer,
or payment mutation was required. The original gate remains rejected with zero
credit, and provider recovery does not reconstruct missing durable traces.
Independent receipt review passed the scoped recovery, including exact identities,
artifact hashes and fresh terminal card/Stripe checks. Fresh complete payment gates
remain required; the existing case remains open. Future cancellation must target
the sealed benchmark owner first and keep services available through drain.

## Validation outcome: corrected TRACE1 smoke hit transient R2 DNS failures

Corrected smoke run `6b3758e0-e471-48d7-818e-31d08623bb75` on source
`864644162722720784dd60447cd8d461cefa54de` retained its original stack and
database after failing the gate. Native process evidence confirms
`TRACE_ARCHIVE_ENABLED=1`. Six earlier automatic finalization events covered five
distinct roots with nonempty R2 manifest references: webdecoy appeared twice, and
chat-mode had no earlier finalization event in that capture. The final owning archive barrier nevertheless
received five HTTP500 responses: one required public-manifest write failed, and
four finalization-marker writes failed. All six exact provider cleanup receipts
were retained. Task evaluator passes do not repair those infrastructure failures.

The earliest observed storage boundary is `getaddrinfo ENOTFOUND` for the exact
bucket-prefixed R2 virtual host at 01:20:09.972 UTC. Retained backend logs contain
28 such failures through 03:02:21.215 UTC, including exhaustion of the existing
bounded write retries. This is a different cause from inherited disabled capture
and premature operator stack cancellation; no source repair is established.
Archive searches covered missing final manifests, asynchronous finalization,
storage-mode mismatch, and R2 DNS failures before this conclusion.

Read-only checks later found that exact virtual host and its account endpoint
resolving on both the Mac and the cloud controller. The unchanged SDK returned
HTTP200 for all six encrypted and public manifests. A path-style comparison
returned the same lengths, providing no current evidence for an addressing fix.
The original `spawn-sub-agents` owner was then used for the unchanged real
`archive_agent_finalize` call with its original passing evaluator outcome and
force flag: the strict nonempty-reference assertion passed in 3.882 seconds.
That postmortem success follows external storage recovery; it grants no credit
to the original run, reconstructs no missing traces, and does not establish the
cause of the transient DNS loss. Host-power event counts alone are not causal
evidence.

Private source hashes, diagnostic reports, exact-host observations and the
owning unchanged reproduction are retained in
`.context/acceptance/smoke-trace1-rca/`. Both failed local stacks were retained
through the scoped recovery; fresh complete required gates and the consecutive
cloud proof remain outstanding.
No production source, prompt, model, task, evaluator, timeout or evidence
requirement changed for this diagnosis.

The sibling corrected payment gate retained exact before/after/final SQL and
provider/payment receipts for its three reported roots. Its fourth task returned
HTTP500 without an agent ID. The exact request correlation showed a committed
root followed by a Temporal start attempt with no success event and the SDK's
generic `Failed to start Workflow` message. The underlying RPC cause was not
logged, so the observed R2 DNS failure is not asserted as this RPC's cause.
The runner already rejects an unknown creation outcome and retains the failed
stack; it did not acknowledge successful teardown for this missing root.

Recovery queried only that captured root. The original SQL row was present and
unsealed, with one agent, zero browser sessions and zero purchases. A fresh
exact Temporal describe observed no execution. The canonical root DELETE
returned HTTP204; subsequent exact SQL confirmed the deleted root, no unsealed
descendants, no provider sessions and no payment obligations. A second exact
Temporal describe still observed no execution. The original error and zero
credit remain unchanged, and both stacks/databases remained retained during this
check. This scoped recovery does not justify a network retry or a production-source change.

After those checks, all six smoke roots and all four payment roots were queried
again in their exact original databases. All ten trees were sealed, and their
payment ledgers had zero pending obligations. Eight exact root workflows were
terminal; chat-mode and the unreturned creation root had fresh NOT_FOUND
observations, with the SQL deletion fences providing the durable admission
boundary. Original context bytes and two complete owned-database snapshots
were preserved privately before any service stop. The existing stack owner
helper then verified each sealed PID/native birth identity and stopped only
those two stacks. Clean receipts took 7.526 and 5.154 seconds; their recorded
service identities, exact database containers and volumes were absent afterward.
Appended terminal logs and the original snapshots remain retained. No unrelated
process or database was touched, and neither failed gate receives proof credit.


## Recurrence: native recording lost after an empty screenshot handoff, October 1

Proof85 run `20261001-084827-31152`, owner
`fbdaed7cb2e54929928a69cf217f3a93`, used immutable source
`9d6b571a20f4442ea980e68d7bcc1b8f049e676a`. Nine task children returned
records and guest cleanup acknowledgements. `polar-bu-063`, root
`b5c2dde8-0468-4bf5-a51f-cbadd2d0cfdd`, failed owned evidence finalization
with `archive: TimeoutError`. Its last snapshot at 09:03:55 UTC had FINISHED
browser terminals but only an IN_PROGRESS recording, without an attachment.
The strict collector then received HTTP500 from `/shutdown-health` with
`driver exited without cleanup acknowledgement`. That collection error is a
consequence of the failed guest barrier, not evidence of an OOM. The original
slice remains rejected with zero acceptance credit.

The browser task `997c87bb-459a-56ae-b3ee-e71b9c9fddc3` began Kernel replay
at 08:59:18 UTC. Challenge recovery promoted a Steel session; the outgoing
native finalizer logged `has_view_url=true` at 09:01:06 UTC. The raw provider
response and signed URL were not captured, and fresh media reachability was not
verified. The promoted screenshot
timed out, and the final screenshot encountered a closed browser. Original
recording scratch has zero frames and no player file. The first bad producer
boundary is `BrowserAgentRecorder.close`: after changing to screenshot mode,
it returned no recording when frames were empty, ignoring retained native
replay segments. `export_inline_html_bytes` had the same empty-frame guard.
Thus the prior handoff regression, which always captured a promoted screenshot,
missed loss of an already captured recording. The cause of the original CDP and
screenshot failures remains unproven.

The new permanent browser blackbox executes the real recorder's native replay
rotation and Kernel-to-Steel transition, then the real FE finalizer with failed
screenshots. The identical test fails on the original recorder in 0.577 seconds
and passes after the fix in 0.744 seconds. It requires a nonempty uploaded player
and acknowledged FINISHED recording attachment, executes that player in a local
browser, and checks both retained segments in order and the visible final video.
It records zero screenshot frames; no frames or provider recordings are invented.
A screenshot-only recorder with no captured evidence still returns no recording.
Six existing handoff, player, native replay and backend-acknowledgement controls
passed in 0.789 seconds. The complete owning browser domain then passed all 628
registered cases in 40.112 seconds, using the activated environment and unchanged
runner/fixture bounds; its exact source bindings are retained separately.

Independent review found one new empty-frame control error: toggling skip idle
called the frame renderer with no images. The same added case now captures page
errors and toggles the real control before and after native segment completion.
This final test failed on the draft in 1.339 seconds and passed with a one-line
empty-frame render guard in 2.023 seconds, both from the activated agents
environment. Six unchanged nearby controls pass on these final bytes in 0.863
seconds; all 627 original browser test bodies remain AST-identical. The prior
complete-domain result is not relabeled as execution of this final guard. The
final canonical agents gate remains required. All player requests were aborted;
these checks prove player sequencing, controls and attachment persistence, not
native media availability. The new case is registered in the owning browser
blackbox domain.

The repair preserves retained native URLs through both empty-frame guards,
labels the zero-frame manifest as `kernel_replay`, and keeps the last native video
visible when no screenshot timeline follows it. Empty-frame rendering is a no-op.
It adds no provider request,
model call, polling service, global state or timeout. Work and memory remain
bounded to the recorder's existing segment list; no per-fleet scan is added.
Task definitions, prompts, models, evaluators, execution bounds and recording
readiness requirements are unchanged.

Before recovery, original guest logs and run records were archived privately:
21 files, 20,582,869 source bytes, archive SHA-256
`938e3542a8d168752949bbedc9e8bc23fac5081fb1024984dec52bef103b0c00`.
The exact recording directory was also preserved outside the guest, archive
SHA-256 `707cac036be03494f2ce828206c87861bd6987de8f73857a6b25cd98ed23b183`.
Original cleanup records confirm the root deleted and its tree sealed, one exact
Steel session closed with HTTP200, and no purchases. They do not replace the
missing archive or guest acknowledgement. Private evidence, source/test hashes
and unchanged RED/GREEN receipts are in
`.context/acceptance/proof85-polar-runtime-rca/producer-diagnosis.receipt.private.json`;
final source/test bindings, the corrected URL-observation limits and all retained
receipts are in `producer-final-ready.receipt.private.json` in that directory.

Archive searches covered `driver exited without cleanup acknowledgement` and
`guest exited shutdown health 500 runtime evidence unsealed`; this is a producer
recurrence of this recording/finalization case. The user required compact owning
regressions and zero INFRA acceptance, so no broad suite or paid task was launched
for diagnosis. The causal regression does not establish the exact unchanged
benchmark outcome. The subsequent outcome diagnostic below preserves that
distinction; the required consecutive fleet proof remains outstanding.


### Final source validation and unchanged outcome diagnostic

The final canonical agents gate on `bb4a5561263b2ef9f4600e33ae936e1d4801a118` passed all 103 blackbox domains, 162 cache tests and 102 unit tests with the unchanged coverage gate. This includes the final empty-frame player control fix. The canonical nine-task local smoke also passed with durable lifecycle and exact resource cleanup verified.

The unchanged live `polar-bu-063` outcome diagnostic ran on `bb4a5561263b2ef9f4600e33ae936e1d4801a118` as native run `20261001-094943-10042`, root `5db41081-6d01-4d82-9880-bc74b7515609`. It completed in 78.3 seconds with a genuine task FAILURE: the model used research/search/fetch tools and omitted the required browser tool and browser trajectory, failing the original expected-tool and minimum-step guards. Captured request schemas offered the browser option; the observed tool operations finished without FAILED/ERROR statuses or authentication/session/transport exceptions. The owning query verifier certified 19 completed correlated LIVE queries and zero terminal model-request failures. The task, evaluator, prompts, model configuration, 300-second execution cap and 1800-second allocation deadline remained unchanged.

Strict canonical evidence publication passed and verified the durable frontend for the exact root. Native lifecycle verification returned the borrowed machine stopped with its claim released; a fresh exact provider status read confirmed that machine and its bound volume, the root was deleted and tree sealed, and all known owned sessions were empty. Native lifecycle took 334 seconds, allocation to durable publication took 633.562 seconds, and final ownership verification occurred at 1258.843 seconds, below the unchanged 1800-second cap. The diagnostic has zero acceptance credit and adds no campaign exclusion.

This run allocated no browser agent or provider browser session, so it did not exercise native-to-Steel promotion with zero screenshot frames or establish live native media reachability/decoding. The separate identical-test real-recorder/Chromium RED→GREEN proof establishes the producer/player repair. The live result establishes a clean evaluated task failure with complete applicable durable evidence and teardown. It cannot recover lost original traces or close unrelated historical outcome/observability gaps. Private bootstrap and observer configuration failures are retained separately; none caused a paid task rerun or changed production behavior.

Evidence: `.context/acceptance/proof86-bu063-outcome/outcome-final.receipt.private.json` (SHA256 `18ac6ab073f2e72486b8976311cb364741b561e900e76d39e6b254b1286c8795`), strict durable manifest SHA256 `8a43b9d43b0c3175733d66a857fc4f3121dbb3919fd06a9268b6b5225ea19d23`, native audit SHA256 `883054d98f5ffd6ead2af535454583f6c7b989ab3e76f33286ae88fe08c37f55`, sealed 154-member private archive SHA256 `c6c167819b42f2ef404dbdb2f367ed1a55f6c859a20ad7afc297077a4fe3c9af`.

### 2026-10-01 recurrence: write approval remained parked after PAUSE

Run `20261001-131557-13371`, source `8289a73e`, rejected its first slice.
`browser-agent-amazon-cookie-payment` returned a write-approval request at
13:23:52 UTC and persisted its recording at 13:23:56. The root received PAUSE
at 13:24:12. The final readiness observation at 13:25:40 still had
`recording=true, complete=false` for that exact browser task. Finalization
reported `archive: TimeoutError`; the controller then correctly rejected the
missing driver cleanup acknowledgement. Credential injection had completed in
282 ms, and retained backend logs contain no OOM marker. No RSS samples were
captured, so this is not a memory-peak or original-OOM resolution claim.

The browser activity deliberately defers its terminal while a resume is pending.
Its manager then called the direct approval helper, which waited for a response
or generation handoff but did not observe workflow PAUSE. The completed activity
could finish its recording while that manager remained parked. Archive readiness
correctly required both the recording and the same-task terminal. Searches of
this case, the September 29 premature runner-receipt case and the September 6/11
abandoned-resume cases distinguished that producer failure from the downstream
collector error. Neither archive readiness nor cleanup acknowledgement is relaxed.

The owning fixture runs the real manager, direct approval helper, handoff wait,
bound `AgentWorkflow.pause`, tool-event serializer and message POST through a
local HTTP transport, then the actual archive refresh predicate. Only scheduling,
browser activity and external I/O are substituted. On unchanged source it failed
in 1.217 seconds because PAUSE left the manager parked; the identical fixture
passed in 1.096 seconds after the repair. An earlier unmocked Temporal logger
error is preserved as invalid fixture setup, not causal evidence. Independent
review exposed PAUSE during persistence of the granted-approval event; a reproduction confirmed it:
RED in 1.280 seconds, unchanged GREEN in 1.213 seconds after a post-yield guard.

The manager now owns and joins its approval and PAUSE waits, closes only the
interrupted approval chip using its original request metadata, and emits the
canonical same-task terminal when PAUSE ends that deferred resume. Already-paused
admission creates no request. The interruption is not an approval or rejection;
unanswered attention rows retain exact-root DELETE ownership. Generic approval
callers keep their default behavior. Direct external cancellation still propagates
without the manager inventing a terminal; generation handoff is preserved. The
repair uses two owned waits only at this existing approval boundary, no provider or
model call, shared state, fleet scan or larger timeout.

One registered case, `test_manager_write_pause_seals_persisted_browser_for_archive`
in `agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py`, covers persisted
readiness, successful same-task resume, PAUSE races, foreign identities and joined
waits. Existing case bodies remain intact. Private reproduction and review receipts
live under `.context/acceptance/proof88-write-lock-pause-rca/`.

The first aggregate agents gate passed 102 domains but rejected this new case
before manager execution: an earlier network-error case left the shared HTTP
capture handler installed, overriding the fixture's explicit transport. The
ordered earlier-case-to-new-case reproduction failed in 1.298 seconds. The
identical reproduction passed in 0.864 seconds after the new fixture scoped and
restored that capture handler. Production code and all prior test bodies stayed
unchanged. The original failed aggregate and isolated successes are retained
separately; neither is relabeled as a complete aggregate pass.

Original controller evidence was sealed before exact-owner recovery, SHA256
`c979a52c0407b1e855190bd4d2ce2e334b2b12ac645f11546ed7f301957a8ac5`,
with zero files changing during capture. The canonical forensic archive retains
nine sealed tasks and one interrupted task. Recovery returned all ten exact pool
Machines stopped with their expected volumes, zero claims and no owner registry;
its processes retired. Recovery and fixture success award zero acceptance credit.
The source repair requires a fresh task pool and ten consecutive live slices.

### 2026-10-01 review recurrence: cancellation during approval persistence

Independent PR review of `07983702` identified another await outside the direct
approval helper's cancellation handler. The opening message could already be
persisted as IN_PROGRESS when PAUSE cancelled its acknowledgement wait. The real
manager then emitted its same-task browser terminal while that approval chip
remained open. The unchanged owning reproduction failed in 1.228 seconds on
`07983702` and passed in 1.058 seconds with the repair. Cancellation before an
opening exists is distinct: unanswered attention rows retain exact-root DELETE
ownership and are not evidence of this persisted-chip defect.

The same lifecycle gap existed after a genuine response: during approved-event
persistence, rejection-message polling and rejected-event persistence. All three
phases failed together in 1.158 seconds on the opening-only draft, whose original
post-response tail remained byte-identical to `07983702`. That execution is not
represented as an unchanged whole-commit run. The identical three-phase fixture
passed in 0.767 seconds on the final candidate.

Cancellation ownership now spans opening delivery through final persistence for
the existing browser opt-in. Before a decision it persists the original neutral
interruption event; after a decision it finishes the actual approval, rejection
or handoff event. Rejection feedback already captured in the scoped workflow
context survives cancelled polling acknowledgement. Completion persistence may
resend its known event. This adds no feedback fetch, retry policy, model call,
timeout or change to generic callers' default cancellation.

The existing owning case contains these four bounded phase arms; all 628 unrelated
test bodies and its original assertions remain intact. The owning case and ten
existing approval/browser controls passed in 0.838 seconds, including the owning
case's 0.340 seconds. Independent review verified both unchanged RED/GREEN fixture
hashes, final source bindings and retired exact child processes. Archive searches,
original review finding `4156453115`, causal fixtures and receipts are retained
privately under `.context/acceptance/proof89-approval-opening-rca/`; final candidate
review SHA256 is
`877bf8c02f545f7bc3e826e0c90c58dd5b456ae4363983633f1ef4b0a5b4e5bf`.
The prepared campaign on `07983702` was held before any allocation. These local
proofs award no fleet credit; the canonical gate and fresh live campaign remain
separate requirements.

### 2026-10-01 review recurrence: rejection replay changed delivered text

Review finding `4156855737` identified a remaining producer race on `f898e32c`.
After rejection polling returned and the FINISHED message was delivered, a later
USER message could enter workflow context while the delivery acknowledgement was
pending. PAUSE then entered the cancellation handler, which rescanned context and
replayed that same rejection with the later text. The owning reproduction uses
the real manager, serializer and HTTP POST, observes HTTP201 before withholding
its acknowledgement, adds the later USER message, and invokes real PAUSE. It
failed on unchanged source in 1.430 seconds and passed unchanged in 1.215 seconds.
An earlier import-path setup failure is retained separately and is not causal
evidence.

The observed defect is two producer deliveries with different text and identical
lifecycle metadata. The duplicate database-row consequence follows from the
unchanged backend matcher's requirement for both text and full metadata equality;
this fixture does not claim to execute SQL. The producer now records when
rejection feedback has been resolved, including an empty string. Cancellation
rescans feedback only when polling was interrupted before that resolution. Once
delivery begins, it replays the already selected message unchanged. Backend
matching and other tools' lifecycle semantics remain unchanged.

The same registered browser case adds nonempty and empty-feedback delivery arms,
requiring identical replay text and complete metadata after a later USER message.
All 628 unrelated test bodies remain unchanged; no test or suite was added.
The owning case and ten existing controls passed in 1.666 seconds, with the owning
case taking 0.706 seconds. Private archive searches, the immutable fixture and
RED/GREEN receipts are retained under
`.context/acceptance/proof90-rejection-replay-rca/`. The prepared campaign remained
unlaunched and earns zero credit. The standard gate and fresh fleet proof remain
required.

### 2026-10-07 recurrence: payment and authentication waits missed explicit PAUSE

Original Control6 `20261007-155532-35109`, clean source
`5051c0594905da7f1170fd3d20c9d17cca160500`, retained five
`missing single-root tree` query-verifier warnings. Each original owned snapshot
had a finished attached browser recording, but one exact browser task lacked
`task_complete`; the original durable archive wait reported `archive: TimeoutError`.
The authentication task also contained another browser that closed normally.
All six recordings across these five snapshots were present. The optional
`logs.tree` warning alone does not establish lost model queries: the original
correlator independently finds 202 completed LIVE queries on their explicit roots.
The missing task terminal is a distinct, material durable publication gap.

Four payment managers reached the initial approval wait and then received their
exact root's PAUSE: Alchemy 16:20:36.953 to 16:20:58.064 UTC, IMAX 16:27:28.457
to 16:27:39.707, OpenTable 16:25:07.001 to 16:25:23.982, and Toast
16:21:49.917 to 16:22:14.403. The activity had deliberately deferred its
terminal for a resume and had persisted its recording. Unlike the repaired
write-approval branch above, the payment manager called the direct approval
helper without observing PAUSE. It stayed parked until cleanup deleted the root;
no approval-granted or manager terminal followed in the retained events.

The authentication manager entered its own paused assistance wait at
16:19:49.444 UTC. The same root later received explicit PAUSE at 16:24:35.752
and 16:26:32.180. Its predicate only watched the owned response or a transition
to unpaused. Because authentication had already set `is_paused=True`, these
explicit signals made no observable change to that predicate. The final
snapshot remained paused with the recording attached and no same-task terminal.
This is separate from raw workflow cancellation and from an unfinished recording.

Archive searches for `awaiting_payment_card_approval PAUSE recording task_complete`
and `awaiting_auth_assistance explicit pause archive terminal` found this case
and the September 6/11 manager abandonment cases. This recurrence is at the
initial payment/authentication wait, before the already covered rejected or
exhausted payment gates. The original activity's pending-resume behavior and
strict recording-plus-terminal consumer contract are correct.

The owning reproduction extends the existing real manager, direct approval
helper, bound `AgentWorkflow.pause`, HTTP-persisted message/recording and actual
archive refresh fixture. Only browser execution, scheduling and external I/O
are substituted. The exact payment test fails on unchanged production source
because the manager remains parked after PAUSE (6.38 seconds), then the identical
command passes with the repair (7.54 seconds). The unchanged authentication test
also fails at that owning boundary (45.26 seconds under host load), then passes
with the repair (2.68 seconds). Initial import/fixture setup failures are retained
separately and are not counted as causal RED evidence.

The payment branch now uses the existing pause-aware browser approval helper.
An explicit pause closes only its interrupted approval chip and emits the
existing task-scoped abandoned-resume terminal. The same post-grant guard as
the write branch prevents a pause during persisted `payment_card_ready` from
starting another activity. Actual decisions and minted cards are preserved.

Authentication now distinguishes its own paused wait from explicit PAUSE signals
using a workflow-local sequence. The manager captures the sequence before its
first suspension and only a later explicit signal ends the pending resume.
The sequence travels in the existing continuation runtime; a parked auth resume
also carries its original sequence. Thus a pause between parking and continuation
cannot disappear when the manager re-enters. Owned authentication replies and
ordinary resume still reuse the same task/session. Raw cancellation and generation
handoff retain their existing behavior. The existing abandoned-resume event is
excluded from model context and does not invent authentication or task success.

Four permanent tests are registered in the ordinary browser blackbox runner:
payment and auth pause-to-archive reproductions plus their successful-resume,
foreign identity, simultaneous response, persistence, cancellation and handoff
controls. The auth handoff control executes actual park, continuation serialization,
restoration and manager re-entry, both with and without an intervening explicit
pause. Existing production deadlines, recording readiness, benchmark tasks,
prompts, models and evaluators remain unchanged. There is no provider/model call,
fleet scan, new timer or historical transcript repair.

Original Control6 remains failed and earns zero acceptance credit. Its original
controller exited 1 with 49 sealed host artifacts and one host ENOSPC capture
error; documented recovery recaptured that original guest artifact without a
task rerun. All 50 original TaskResult grade acknowledgements match their exact
owner packets and precede original child finish and guest shutdown. Final supported
query diagnostics cover 45 artifacts and 841 completed correlated queries, with
historical overlap lower bound 35; the five tree-shape warnings remain separately
qualified. These are sealed completed-query diagnostics, not live concurrency or
all-50 latency proof. No visual browser/pixel proof is available.

Independent retained resource evidence confirms all 50 actual cleanup scopes,
including the account task's nested `logs.post` root, sealed/deleted with zero
cleanup errors. The 34 exact owned browser allocations have 32 absent HTTP404
receipts and two successful canonical Steel release HTTP200 receipts. Normal
native teardown and exact orphan-volume retirement completed at
1791391681.430532, 3854.431 seconds after the original first image invocation.
Resource release does not restore the five missing durable task terminals or
recover the original one-hour acceptance failure.

Private original joins, immutable RED/GREEN logs and source/test bindings are
under `.context/control6-independent-observer-20261007/` in the owned diagnostic
checkout and `.context/browser-payment-pause-rca-20261007/` in the isolated repair
checkout. The independent resource receipt SHA256 is
`dfc381951fe9e13b7f98f3945373b01bcb274f70bb6bc1fbbd0a7b83257b6194`;
the final original/recovered query and publication join is
`8b0847ac17ec50ad811e829af9241f8f5ac1acf0b0a647ebdf1e4770c2a52af8`.
The canonical deployment gate and fresh unchanged CLI fleet outcome remain
required; offline producer GREEN does not count toward the five consecutive
50-task LIVE proofs.

### 2026-10-07 recurrence: PAUSE followed by RESUME disappeared during card mint

CodeRabbit discussion
https://github.com/Rose-Ai-Labs/rose/pull/1431#discussion_r4210080313,
review `5446122315`, identified the payment continuation guard on exact source
`fe8e1578e75dc5cde5709aa57e127697726b648d`. After an awaited mint, that guard
only inspected current `is_paused`. Actual `AgentWorkflow.pause` increments the
persisted `_pause_signal_sequence`; `resume` clears `is_paused` but preserves the
sequence. Thus PAUSE followed by RESUME during mint could start another browser
activity for the pending task. This is an async interruption ownership bug,
within the existing logical-inconsistency-in-harness-contracts problem class.

Archive searches used `pause resume sequence payment abandon terminal` and
`interleaving approval interrupt resume mint browser`. They found this case and
the September 6/11 payment abandonment cases. The completed AgentCard and browser
auth plans confirm the existing approval flow and same-task resume contract.
The full path is the deferred browser activity, direct approval, awaited mint,
persisted `payment_card_ready`, manager continuation, then task terminal consumed
by the durable archive predicate. The first bad boundary is the manager's
continuation decision: a current-state flag cannot preserve an intervening signal.
The previous payment repair observed pauses that remained active; auth already
used the sequence to distinguish explicit interruption from its own paused wait.

The permanent reproduction extends the existing
`test_manager_payment_pause_seals_persisted_browser_for_archive` and its owning
fixture. An Event suspends mint after the actual approval has completed; the
test calls actual `AgentWorkflow.pause` and `resume`, verifies unpaused state with
sequence 1, then releases mint. It retains actual manager message serialization,
the exact task's persisted recording, archive refresh/readiness predicate, and
the foreign-task-terminal negative control. No model trajectory is fabricated.
On unchanged `fe8`, the test fails with
`AssertionError: explicit PAUSE resumed an abandoned browser`: it observed two
activity starts. The identical test and command pass after the repair, with one
start, one same-task abandoned terminal excluded from model context, and actual
archive readiness. Initial import/runner setup failures are retained separately
and do not count as RED evidence.

The manager now snapshots the payment pause sequence before lookup/approval
awaits and compares it, together with the existing current-pause check, before
continuing. The original approval and minted-card behavior is preserved. The
existing abandoned-resume event closes the task without inventing purchase
success. This is constant-space local state and a constant-time comparison at
10,000 agents; no scan, timer, poll, provider request or additional gate is added.

Golden references were searched for interruption/cancellation across suspension
and reopened at the implementation. Claude Code
`claude-code-src/src/cli/structuredIO.ts:490` rejects the outstanding request on
its once-only abort listener. OpenClaw
`openclaw/src/agents/tool-search-code-mode.ts:142` settles the pending operation
on its parent abort listener. Codex
`codex/codex-rs/core/src/tasks/mod.rs:400` checks a task-owned cancellation token
after its awaited run; `:940` cancels that token, which remains cancelled for the
old task. Its read-only checkout is `622e9e36962105af50b9c250902e8b8c66a950d8`.
These preserve the interruption of the suspended operation. Hermes
`hermes-agent/agent/interrupt_control.py:104` fences generation-specific interrupt
claims, while `:197` explicitly clears mutable interrupt state; no exact Temporal
PAUSE-to-RESUME analog was found. Rose's existing persisted sequence supplies the
operation-history check without introducing another cancellation mechanism.

The reproduction remains registered in the existing browser blackbox
`run_all_tests`, reached through `scripts/test.sh agents spawn-browser-agent-v3`.
Existing payment approval/interruption and authentication pause/handoff owner
controls pass. The identical command, source/test bindings and immutable RED/GREEN
logs are retained at `.context/payment-pause-mint-rca-20261007/proof.safe.json` in
the isolated `rose-payment-pause-mint-20261007` checkout. This offline causal proof
does not establish original benchmark success or count toward the five fresh
50-task LIVE runs. The frozen candidate and Control7 were not edited.

### 2026-10-07 recurrence: write grant persistence also lost PAUSE followed by RESUME

Independent review of payment source `d16141950c4cac5376baaa41f324536c4c9049ca`
found that the sibling deferred write continuation still checked only current
`is_paused`. Two archive searches used `explicit PAUSE resumed an abandoned
browser` and `pause resume persisted write grant browser continuation`; both
pointed to this case and the existing browser gate abandonment cases. Their
solutions and human feedback require exact task terminals, preserved approval
decisions and narrow coverage in the existing deploy owner.

The actual existing `test_manager_write_pause_seals_persisted_browser_for_archive`
was extended with one PAUSE-to-RESUME scenario at the write grant persistence
activity. The fixture calls actual `AgentWorkflow.pause` and `resume`, verifies
unpaused state with sequence 1, and retains the actual grant serialization,
same-task recording, archive readiness predicate and foreign-terminal negative
control. Before the repair, the ordinary manager started a second browser
activity and the test failed with `explicit PAUSE resumed an abandoned browser`.
This is local runtime evidence, not an inferred failure or a model trajectory.

The first bad boundary is the deferred manager continuation after the grant
yield. Its current-state check forgot the explicit signal when RESUME cleared
the flag. The deeper evidenced gap is using mutable state to authorize an old
suspended continuation. The earlier write test held PAUSE active, so it could
not expose this inverse; the payment repair had not covered the write sibling.
The problem class remains logical inconsistency in harness interruption
ownership contracts, rather than model capability, provider or configuration.

Write now snapshots the existing persisted pause sequence before approval and
compares it at its existing pre-continue pause check, just as payment already
does. Authentication retains its sequence across its distinct intentional pause
and generation handoff. The repair emits the existing exact-task abandoned
terminal excluded from model context. It does not alter approval decisions,
browser prompts, task definitions, evaluators, model calls or timeouts. It adds
only constant local state and a constant-time comparison at 10,000 agents.

The identical command and test recorded RED exit 1 in 1.892 seconds and GREEN
exit 0 in 0.893 seconds. The owning test also runs normal approval, active pause,
concurrent approval, persisted replies, cancellation and generation handoff
controls. Five existing payment, registered-activity-name, authentication and
handoff controls passed in 1.150 seconds. The unchanged test SHA-256 is
`7d573ca9c3a72b2d9e85701f652b08071d5583bffea2cef3e2778908cc45f2c7`.
Exact argv, source hashes and immutable private logs are retained at
`.context/write-pause-resume-rca-20261007/proof.safe.json` in the isolated
`rose-write-pause-resume-20261007` checkout. A controls-launcher syntax error
occurred before test execution and is not causal RED evidence.

Golden implementations were reopened read-only: Claude Code
`claude-code-src/src/cli/structuredIO.ts:490` rejects the outstanding request on
abort, and OpenClaw `openclaw/src/agents/tool-search-code-mode.ts:142` settles the
operation on parent abort. Both keep interruption attached to the old suspended
operation. Hermes `hermes-agent/agent/interrupt_control.py:104` fences claims with
an activity generation; it is not an exact Temporal PAUSE/RESUME analogue. Rose
uses its existing sequence without adding a cancellation mechanism or a new
guard on unrelated active browser execution.

The reproduction remains in the existing browser `run_all_tests` registration,
reached by normal agent blackbox coverage in `/deploy` Step 4g. This offline
causal proof uses no provider/model calls and grants zero LIVE50 credit. The
canonical deploy gate and a fresh source-bound ordinary CLI benchmark outcome
remain separate requirements; Control7 and Control8 sources were not edited.

Final qualification used the identical frozen fixture on baseline
`8b895022f541ed6481711168cd0961f8b0778396`: both payment and authentication
checks failed because real PAUSE left the manager parked (2 failed, 3.87 seconds).
The final repaired owning selection passed eight checks in 2.75 seconds, and two
existing continuation controls passed in 1.63 seconds. Independent review passed
three real manager/archive checks in 1.74 seconds. All 666 existing test bodies
are unchanged; the four new checks are registered in the ordinary domain runner.
Final syntax and same-path baseline/current lint checks report zero new diagnostics.

The final replay-surface generation is `69be3fc881f1` across 273 files, compared
with baseline `1ea6b130bacf`; both changed production modules are included. The
existing deployment policy selects a new versioned queue for this changed hash,
keeps old workers on their old histories, and moves cooperative handoffs through
`continue_as_new`. This binds compatibility to the required generation cutover;
no replay of old histories on the changed code was executed or claimed. Final
source, unchanged-fixture RED/GREEN, registration and generation bindings are
sealed in `final-qualified-handoff.safe.json` in the private repair directory.
Canonical deployment and a fresh normal CLI LIVE50 outcome remain required.

Independent parent review of final write source
`854008ea2160845ec984bdbfd427d405f76da47a` completed on October 7. It verified
the complete three-path diff, the unchanged-fixture RED/GREEN logs and their
source/test hashes, normal owner registration, and the clean remote source.
Three existing write, payment, and authentication/handoff manager/archive checks
passed in 1.303 seconds without model or provider calls. The immutable parent
receipt is `.context/write-pause-resume-rca-20261007/root-independent-review.safe.json`
in `rose-write-pause-resume-20261007`, SHA-256
`dc9d5e3857c44d31a325ef2c850e2ca822cff285de9e9f36ea6af4b12cfc1a8d`.
The original author proof remains unchanged. Source review is clear; canonical
deployment and fresh ordinary CLI LIVE50 outcomes remain separate requirements.

### 2026-10-07 review recurrence: parked approvals lost their original pause sequence

Fresh deploy review `5446956115`, inline `4210794699`, identified a distinct
continuation boundary in the existing write/payment wait. The same permanent
archive controls now park the actual tool, serialize and restore the actual
`AgentWorkflow` continuation, execute PAUSE followed by RESUME between generations,
and deliver the original approval decision. Both controls failed on the reviewed
`97219c42f` source: the restored workflow correctly retained sequence1, but the
manager started a second browser activity instead of ending the original task.
The recorded assertion was `len(starts) == (1 if pause else 2)` at the parked
archive boundary. This is an owning-boundary review reproduction, not a claim
that a live benchmark failed or passed.

Critical path: original approval branch captures sequence0 → approval parks its
existing request/result → workflow continuation retains a later sequence1 →
manager re-enters approval and captures sequence1 again → the existing resume
check sees no change → the same browser task starts another activity. The first
bad boundary is the approval parking producer: unlike auth, its hint omitted the
original sequence. The workflow continuation itself retained the correct state.
The general problem class is loss of decision-time state across a resumable wait.
The previous guardrail covered same-generation grant/mint races and auth parking,
but omitted write/payment continuation restore after an explicit pause and resume.

Archive searches were `Preserve approval pause sequence across generation handoff`
and `write payment paused browser resumed archive cleanup`. This is a recurrence
of the exact-task archive producer case; the cooperative attention-wait case
`2026-10-02-cooperative-approval-handoff-leaves-attention-pending` is a relative
with a different first-bad field. Its solution preserves the original request
identity rather than opening a replacement request; this repair preserves the
original approval sequence in that same parked identity.

The shared `park_browser_approval` producer now carries
`approval_pause_signal_sequence`. Only a re-entered approval branch restores it;
the existing write/payment resume checks compare against that original value.
There is no manager-entry cancellation check affecting an active browser. A
legacy hint without the field uses the previous current-sequence behavior.
Deleting parking would break normal generation handoff; sharing the producer
field unifies both affected approval branches without another wait or cancellation
path. Approval decisions, metadata, pending card references and auth state remain
on their existing paths.

Permanent owners are the existing registered
`test_manager_write_pause_seals_persisted_browser_for_archive` and
`test_manager_payment_pause_seals_persisted_browser_for_archive`. Their immutable
post-extension test SHA-256 is
`14eb735af9fe8656b7450a5b9c754170692d5824f8ee0be781b2dc9b370a0e9c`.
From `agents`, the identical pre/post command for each owner was:

```bash
source venv/bin/activate
PYTHONPATH=.:tests/blackbox python ../.context/registry-checkpoint-deploy.private/parked-approval-owning-launcher.private.py <existing-owner-name>
```

Both actual RED exits were1; both unchanged GREEN commands exited0. All ten
existing registered write/payment/auth and terminal manager controls then passed,
including normal parked handoff and missing-field legacy hints. The structural
registration owner confirms deploy discovery. Raw logs and source hashes are
sealed privately in `parked-approval-handoff-proof.safe.json`; initial launcher
import-path failures are preserved as diagnostics and receive no causal credit.

Golden references were read directly: Claude Code
`src/hooks/useCancelRequest.ts:99` retains the original abort signal and clears
pending tool confirmations on cancellation; OpenClaw
`src/talk/agent-run-control.ts:83` selects the exact admitted owner and its signal;
Hermes `gateway/platforms/api_server_runs.py:651` releases the original approval
waiter when its run is cancelled; Codex
`codex-rs/core/src/session/step_activation.rs:247` captures the original task and
rejects a cancelled target, and `session/turn_suspension.rs:72` cancels that task's
token. Codex source was read at `8f21b7fffbefe77529325fc86c95289371841c6c`.
These references share identity-bound interruption state; none supplies Rose's
Temporal browser continuation protocol. The exact internal auth hint remains
the applicable serialization example.

The runtime generation changes from `4c15cedbe12e` to `86f944c4e051`; the active
C9 image/source remains immutable. No model/provider calls, task definitions,
evaluators, timeouts, archive readiness assertions or benchmark outcomes change.
Independent parent review and final exact-head automated review remain required;
this note gives no fresh whole-suite, production rollout or LIVE50 credit.

Independent parent qualification on `2617cfb6f` read the complete production,
permanent-test and archive diff, verified all original RED/GREEN log hashes and
unchanged source/test bindings, and repeated four existing write/payment/auth
owning controls: PASS in 2.141 seconds, with stable source and zero provider calls.
The receipt `root-parked-approval-independent-review.safe.json` has SHA-256
`632560727f529e34af2332ee115fbfce3aa2d132f5867fbadd5f143abfd8c6c3`.
The author proof remains immutable. Exact-head automated review and production
rollout remain separate mandatory gates; this qualification adds no LIVE50 credit.


### 2026-10-07 review recurrence: restored payment pause checked after card mint

Fresh exact-head review `5447373912`, inline `4211148049`, found a remaining
financial boundary on `d03b9eb8c`: restoring the original approval sequence
prevented browser resumption, but the first card mint still preceded that check.
The existing permanent payment archive controls now count actual mint activity
calls. Three unchanged commands failed on the reviewed handler: an approved
parked PAUSE→RESUME minted a card, PAUSE→RESUME after actual approval persistence
minted a card, and PAUSE→RESUME during the company-funding wait issued a second
mint. All three assertions passed after the repair, using identical test bytes.

The critical path is original approval sequence → actual continuation restore or
approval persistence → changed sequence while active → card activity → final
browser-resume check. The first bad boundary is the financial side effect: it did
not enforce the same original sequence as the browser resume. The prior test
observed only browser activity starts, so a cancelled browser with an already
minted card incorrectly passed. This is an owning-boundary review recurrence;
no live task or benchmark outcome is claimed. Archive searches were `Check the
restored pause sequence before minting a card` and `payment approval card side
effect after pause generation handoff`. The October2 cooperative attention case
is a relative; this existing archive producer case owns the recurrence.

The shared predicate now checks both current pause and the supplied original
sequence. Payment passes that sequence into its existing joined approval helper.
An interrupted fresh request is never opened; a parked request runs the existing
response/cancellation path so its real decision is preserved or its exact pending
chip is closed. Every mint attempt checks that predicate, including funding and
setup/gate retries. A private control-flow exception returns the existing exact
browser-abandoned terminal. The final browser-resume check remains necessary for
a pause occurring during an already-started mint or card-ready persistence. No
manager-entry guard, fabricated rejection/card, alternate approval, timeout or
benchmark definition is added. Legacy hints still use the current sequence.
Deleting approval or mint retries would break valid purchasing; unifying their
interruption predicate and the mint entry point prevents these proven siblings.

From `agents`, the exact pre/post recipe was `source venv/bin/activate`, then
`PYTHONPATH=.:tests/blackbox python
../.context/registry-checkpoint-deploy.private/parked-approval-owning-launcher.private.py
<existing-owner>`. Existing owners are
`test_manager_payment_pause_seals_persisted_browser_for_archive`,
`test_manager_payment_pause_preserves_approval_and_interruptions`, and
`test_manager_payment_card_approval_uses_registered_activity_names_and_resumes`.
Each actual RED exited1; each unchanged GREEN exited0. All ten registered
write/payment/auth owning controls passed, preserving actual decision metadata,
normal parked handoffs, legacy hints and exact archive/browser identity. The
immutable proof and original log hashes are private in
`payment-mint-boundary-proof.safe.json`.

Golden references were re-read directly: Claude Code
`src/hooks/useCancelRequest.ts:99` uses the original abort signal; OpenClaw
`src/talk/agent-run-control.ts:83` binds control to the admitted owner/signal;
Hermes `gateway/platforms/api_server_runs.py:651` releases that run's approval
waiter; Codex `codex-rs/core/src/session/step_activation.rs:247` retains the
original non-cancelled target and `session/turn_suspension.rs:72` cancels its token.
They share identity-bound cancellation; Rose's existing approval service supplies
the actual decision-preservation protocol used here. Independent root review and
fresh exact-head review3 remain required. No model/provider calls, C9 mutation,
production rollout, fresh whole-suite execution or LIVE50 acceptance is claimed.


Independent root qualification on `18fa07250` read the complete production,
permanent-test and archive diff, verified every original author RED/GREEN log
hash and unchanged source/test bytes, and repeated five existing registered
payment-mint/write/auth owning controls: PASS in 1.238 seconds. The private
`root-payment-mint-boundary-independent-review.safe.json` receipt has SHA-256
`68475694d94869a4a208e58022cd49cf07133f034842feabf750efb9700d43e7`.
The author proof remains immutable. Fresh exact-head review3 and production
rollout remain required; this source qualification gives no LIVE50 credit.


### 2026-10-07 review recurrence: write omitted the shared approval sequence

Verification review `5447578139` found one outside-diff issue at `handler.py:10923`
on exact `886bdb4f8`: the write caller omitted the original sequence from the
shared approval wait. Its final browser fence stopped activity resumption, but
it first emitted `write_lock_granted` after PAUSE→RESUME. The unchanged existing
write archive owner now observes that permission event and failed with
`abandoned parked write granted permission` in 1.693 seconds. The identical
command and permanent test bytes pass after the repair in 1.051 seconds.

The previous repair exposed a shared optional keyword that only payment used.
That optional interface allowed this proven sibling to survive despite correct
parking state and a final browser fence. The deepest owned cause is an approval
wait whose interruption contract could be silently omitted. The keyword is now
required, and both production callers explicitly supply their original captured
sequence. The existing permanent control asserts that omission cannot become a
new silent caller default, and tests both currently paused and already resumed
interruption without opening a fresh attention request. No new wait, manager-entry
guard or cancellation path is added. All four initial/setup/subscription/KYC mint
call sites still enter the one guarded mint loop; funding retries use that same
pre-activity check.

Archive searches were `Pass the write pause sequence into the approval wait` and
`write_lock_granted pause resume parked approval pending`. This is a recurrence
of this case's approval/archive boundary. The golden references and existing
response-preservation service read in the preceding recurrence remain applicable:
original owner cancellation state governs later effects, while a real completed
decision is retained. Deleting the wait would break approval; making its original
sequence mandatory unifies both sibling callers without another optional field.

The existing registered
`test_manager_write_pause_seals_persisted_browser_for_archive` runs actual
continuation serialization/restore, approves the original request after the
intervening pause, and asserts no permission grant, no new browser activity and
a durable exact-task terminal. An unanswered parked inverse also closes its exact
original approval chip. Normal write/payment handoff and missing-field legacy
inverses remain, and all ten existing write/payment/auth owners passed. The
pre/post command from `agents` is `source venv/bin/activate`, then
`PYTHONPATH=.:tests/blackbox python
../.context/registry-checkpoint-deploy.private/parked-approval-owning-launcher.private.py
test_manager_write_pause_seals_persisted_browser_for_archive`. Raw RED/GREEN and
source/test hash bindings are private in `write-wait-required-sequence-proof.safe.json`.

The prior bounded lifecycle closed cycle3 FINDINGS and recorded deploy outcome
blocked/review-unstable before source mutation. Its complete ledger is retained;
there is no fourth cycle. Development stabilization is followed by a fresh
qualified `/deploy` lifecycle and independent exact-source review. Original C9
callers were independently proved quiescent; retained forensic resources are
inert and receive zero acceptance credit. No model/provider calls, benchmark
changes, full-suite pass, production rollout or LIVE50 outcome is claimed here.
