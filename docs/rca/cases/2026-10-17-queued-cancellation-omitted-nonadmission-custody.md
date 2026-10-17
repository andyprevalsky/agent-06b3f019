---
id: 2026-10-17-queued-cancellation-omitted-nonadmission-custody
date: 2026-10-17
title: Cancelled scheduler waiters lacked coordinator-owned nonadmission proof for strict batch cleanup
surface: harness
component: benchmark-coordinator-cancellation-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: main_async cancellation fallback creates rootless CANCELLED TaskResults without retaining whether the exact pending executor occurrence ever entered _run_reported_task
symptoms:
  - owned cloud execution has an unknown root creation outcome
  - Queued inbox waiters cancelled before executor admission prevent the strict batch cleanup acknowledgement after known roots are released
  - Empty transient admission maps after gather cannot distinguish never admitted from interrupted creation
tags:
  - benchmark
  - cancellation
  - queued
  - resource-custody
  - admission
sources:
  - commit f60a39e19f4402e98cde73419d7777e7c3a52df5
  - benchmark run auth-repair-original30-f60a39e-20261017
  - memory: private queue-cancellation-rca owning baseline and full cleanup-owner proof
repro: Actual source-owned coordinator AST with real scheduler and finalizer fails the registered queued-cancellation control before the private candidate; the full owning cloud cleanup suite passes 49 cases afterward
status: open
---

## Problem

The parent stopped the original infrastructure-invalid attempt through the
existing exact-identity local CLI shutdown owner. The genuine native export was
saved, but the benchmark acknowledgement remained failed with
`owned cloud execution has an unknown root creation outcome`. The parent
reported all 19 known-root provider cleanup acknowledgements before this error;
its later exact canonical stack retirement succeeded separately. No original
native task verdict, failed benchmark ACK or export is rewritten here.

Eleven scheduler waiters had never entered task execution. Cancellation produced
rootless CANCELLED fallback rows with no proof that creation had not started.
The strict finalizer could not distinguish those rows from a CREATE request
whose response was lost. Its refusal was correct for the data it received.
The missing data originates in the coordinator, not a provider cleanup failure.

## Diagnosis

### What, where, why, proof, problem

- **What:** queued, never-admitted occurrences prevent clean resource finalization
  after all known allocated roots have been released.
- **Where:** `_parallel_task_runners` acquires the inbox guard before
  `_run_reported_task`; `main_async` cancellation gathers all pending futures and
  creates fallback TaskResults, but does not retain lifetime admission history.
- **Why:** the existing `_admitted_tasks` and `_admitted_agent_ids` maps are removed
  on executor exit. Their absence after gather is not evidence that the executor
  never entered. A task name, empty root list or CANCELLED status is insufficient.
- **Proof:** an actual coordinator/scheduler/finalizer reproduction produces 12
  duplicate-name occurrences, one admitted root and eleven waiters. Only one
  delegate enters. All waiters return genuine rootless CANCELLED rows. The real
  finalizer releases the known root and then raises the exact native error.
- **Problem:** the coordinator's positive knowledge of nonadmission does not cross
  the deferred resource-verification boundary with exact occurrence identity.
  A missing response after CREATE remains genuinely unknown and must fail closed.

The real `_parallel_task_runners` calls its runner in the same asyncio task.
`run_parallel_task` directly awaits `_run_with_sandbox_payment_lock`, which
awaits `_run_reported_task` without creating an inner task. The execution backstop
creates its inner task only inside `run_single_task`, after reported-task entry.
Thus a sticky set captured before the first await at that entry identifies the
same futures held by the pending coordinator. Tests use the real sandbox wrapper
and assert this identity, rather than assuming task-name equality.

### Archive chronology and related cases

Two queue-specific searches were actually run:
`owned cloud execution has an unknown root creation outcome` and
`queued cancelled never admitted root custody`. They used the source-bound
938-case f60 corpus plus the separately prepared private clock case, giving 939
cases at search time. The original 938 case blobs remain unchanged. These
searches were completed AFTER the first private candidate edit and BEFORE final
freeze; that process omission is retained, not retroactively presented as a
pre-edit search. Earlier clock searches do not count as queue-specific searches.

The October 6 pending-futures report case's Solution and Human feedback were
read in full. It correctly removes transient display/admission rows at executor
exit while preserving allocated-root cleanup custody. The display fix remains
valid; it does not supply a lifetime nonadmission proof for a later cleanup
consumer. This is a distinct deferred-cleanup producer boundary, not evidence
that report counts should retain completed tasks as running.

The September 11 deferred-root-owner case's Solution and Human feedback were
also reviewed. It recovers exact persisted identity for an allocated root; this
case must distinguish absence of allocation before execution from an unknown
allocation attempt. Neither permits a blanket cancellation exemption or a
change to task outcomes, cleanup timeouts, models or provider state.

### Owning reproduction and test truth

The private `cloud_batch_cleanup_test.py` contains the permanent proposed
regressions and is automatically discovered by the unchanged benchmark blackbox
registrar's existing cloud-cleanup loop. The coordinator seam follows an existing
owning test in that same file: compile the exact unmodified `_run_reported_task`
and `main_async` execution/finally AST from the physical f60 module, not a
hand-written implementation. Use real `_parallel_task_runners` and
`_finalize_owned_cloud_batch`; only execution, HTTP, archive, recording,
provider/payment and persistence edges are fake. No actual provider, DB or model
state is read to decide expected outcomes.

The original two owning cases returned normal EXIT1 with one failure and one
pass, 44 deselected, in 1.84 seconds. After fixture-only preparation for the new
optional interface, the same cases still failed before the runtime candidate,
then passed both cases in 1.04 seconds after it. The genuine unknown-create and
rootless forged-not_started control retained rejection.

The final expanded test bytes were also run on the unchanged owner: four failures,
two passes and 43 deselected. Two failures reproduce allocated-plus-queued and
all-never-admitted cancellation; the additional feature-dependent assertions
cannot pass before the new proof interface exists. They are not misrepresented
as four separate production defects. The candidate's whole owning file then
returned EXIT0, **49 passed in 6.02 seconds**, including the unchanged final
regressions and all old cases. Commands use the installed private Python and
PYTHONPATH pointing first to a physical private owner, with the immutable f60
benchmark package as dependency fallback:

```text
python -m pytest -q <private>/agents/benchmarks/cloud_batch_cleanup_test.py -k 'cancelled_inbox_waiters_are_proven_never_admitted or cancelled_unknown_create_stays_fail_closed'
python -m pytest -q <private>/agents/benchmarks/cloud_batch_cleanup_test.py -k 'cancelled or nonadmission'
python -m pytest -q <private>/agents/benchmarks/cloud_batch_cleanup_test.py
```

This is actual owning-boundary proof, not a full benchmark-domain or complete G3
PASS. The runtime source and tests are frozen in the private packet; every one of
the 173 original assertion ASTs and multiplicities remains (183 afterward).
Test doubles for the existing source-coordinator case accept the new optional
keyword and initialize its two added owner containers, preserving old assertions.

### Invalid registrar attempts and custody qualifications

The first private harness omitted args.max_concurrency and failed before task
entry; it is setup failure, not causal RED. A later record-filtered whole
benchmark registrar did execute the new tests, but its unconditional native
subprocess helper starts checks before recording results. Filtering
BlackboxResult.record therefore does not select that helper. Those attempts are
not focused normal-complete registrar proof or full benchmark PASS.

Earlier exact test parents were retired with retained 130/143 results. Their
child births were not captured before retirement; this historical custody gap
remains explicit. The final registrar received one supported SIGINT; its helper
stopped admitting queued native checks and shielded/joined entered checks, then
returned 130. All nine exact identities captured before that final cancellation
were subsequently absent. An incidental native-test result printed during that
join is not new gate credit. Targeted pattern/cwd discovery alone cannot
reconstruct earlier orphan lineage or justify a foreign signal. No general
zero-descendant assertion is made for the earlier incompletely observed attempts.
No more whole-registrar selection attempts were launched.

The evidence-trace/reproduce factory hooks were initially omitted. Only the
appropriate current verify-handoff event was recorded at actual
2026-10-17T21:23:54.270614Z in the private RCA context. No event is backdated and
no tracked benchmark history or shared G3 lifecycle is reset.

## Solution

The PRIVATE candidate adds a sticky set of exact executor-future objects and a
list of exact nonadmission result objects, both local to the coordinator.
Reported-task entry adds its current future before the first await and retains
that fact through cancellation/gather. The coordinator first cancels every
pending future, then awaits them. Only a fallback occurrence never in that set
receives `graded_root_creation_outcome=not_started` and coordinator metadata
with its parallel-phase occurrence index. Its status, benchmark status, grade,
duration and empty agent identity retain their existing CANCELLED values.

The finalizer's optional proof keyword defaults empty, preserving fail-closed
behavior for old callers. Admission requires exact result-object identity using
`is`, empty roots/agent/logs, not_started, false grade, CANCELLED statuses, and
strict producer metadata with a nonnegative integer occurrence index. Equal
or deep-copied dataclass values do not inherit authority. Malformed/foreign
metadata, duplicated proof entries and genuine unknown-create results are
rejected. Metadata alone cannot grant the exemption. All-never-admitted batches
can complete without inventing roots or provider receipts; allocated roots still
traverse the unchanged exact-root cleanup path.

Controls cover duplicate task names as separate future occurrences, an allocated
active root with eleven queued waiters, cancellation before any executor enters,
an entered CREATE with unknown result after transient maps are cleared,
copy/forgery rejection, and prior cleanup failures. No blanket rootless or
CANCELLED rule, SDK fallback, task/evaluator override, grade promotion, timeout
change, new global ledger or schema field is introduced. The existing
stop_metadata field records truthful diagnostics; live object identity remains
an in-process coordinator authority, not a cryptographic proof for arbitrary
external JSON. External collectors must retain their independent source and
custody validation.

The source change has 23 added runtime lines, reviewed as a coherent extension
beyond the initial 20-line guideline. It adds only references/metadata bounded by
selected task count; at 10,000 tasks it is O(N) local memory with no extra model,
provider or cleanup request. It composes with the separate eight-line elapsed
clock candidate without expanding that candidate's scope.

The golden reference `codex/codex-rs/core/src/tasks/mod.rs:549-575` takes the exact
active turn/task, waits for cancellation handling, then clears pending input.
Lines 312-345 separate task registration/admission from pending input state.
The candidate converges on that distinction and ordering; Codex does not supply
Rose's exact allocation-proof contract, so this is a pattern comparison, not
behavioral parity or authority to resume pending work after cancellation.
Golden review was also performed after initial private editing; chronology is
explicit. No fabricated failed Step 5b rung or whole-class-elimination claim is
made.

Runtime/test patches, exact source hashes, command outputs, setup failures and
custody limits are retained under `queue-cancellation-rca/`. No shared product
source, ref, index, task catalog or original export was changed. Independent
source review, central composition, full final-source G3 and unchanged native
outcome verification remain required. This case stays OPEN; private mechanism
GREEN does not repair or regrade the interrupted original30 attempt.

## Human feedback

Preserve genuine unknown creation fail-closed and all original task/model/cap,
terminal verdict and provider cleanup contracts. Use exact future occurrences
and exact result identity, not dataclass equality, current-map absence or task
names. Retain every failed/setup attempt and its real process custody limits.
Do not run a record-filtered whole registrar that launches unconditional native
checks. Full cleanup-owner proof plus actual registered cases/static discovery
suffice for this private stage; final whole-domain G3 remains separate.
No source adoption or deployment was authorized by this packet.

## Reusable lesson

A deferred cleanup verifier needs positive lifetime evidence about whether an
executor ever reached allocation-capable work. Preserve that evidence where the
scheduler knows it, bound to the exact occurrence and result object. Unknown
creation must stay unknown; a missing root ID or a cancelled status cannot prove
zero allocation.
