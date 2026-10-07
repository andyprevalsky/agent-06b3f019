---
id: 2026-10-06-sealed-primary-retirement-waited-for-entire-fleet
date: 2026-10-06
title: Sealed primaries waited for every fleet child before exact native retirement
surface: harness
component: run-bench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet normal child supervisor ended without scheduling independently sealed primary retirement; native admission remained after the whole CHILD_PIDS join
symptoms:
  - last local child to provider-teardown-verified.epoch took 420.095194 seconds
  - all 50 primary native receipts were emitted after the final local child
  - benchmark-child.finished preceded full native global release
tags:
  - cloudbench
  - fleet-retirement
  - scope-finalization
  - bounded-parallelism
sources:
  - commit 1c55715717706ac3b906c256396241d706e85fcb
  - fleet run 20261006-205741-10814
  - memory:sealed-primary-retirement-rca/diagnosis.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_sealed_primary_retirement_overlaps_running_sibling
status: open
---

## Problem

The immutable width-50 DAILY run reached its final original benchmark subprocess
at epoch 1791348001, its last validated primary manifest producer write at
1791348083.687587, and its last collector supervisor finish marker at
1791348087.9048057. The final exact native audit producer published release at
1791348508, then the original CLI ended at 1791348526. These disjoint post-task
segments are 82.687587 seconds of final capture, 4.217219 seconds of local
handoff, 420.095194 seconds through full native release, and 18 seconds of final
controller publication/projection. They sum to the actual 525-second tail.

The actual image-start origin remains 1791344920. Native E2E was 3588 seconds;
full CLI E2E was 3606 seconds. The task execution allowance remained 1200 seconds
per task and does not bound capture, evaluation, or native teardown. The run
has zero qualifying credit. This RCA neither rewrites its source binding nor
attributes its separate provider stalls to teardown.

The original retained stage-chain.safe.json, early-child-handoffs.safe.json,
teardown-ownership/fresh records, and native snapshots are cryptographically
bound in the isolated .context/sealed-primary-retirement-rca/diagnosis.safe.json.
Native snapshots observed 34 primaries at 1791348217, 26 at 1791348290, 14 at
1791348369, 6 at 1791348449, and zero at 1791348592. A later registered-ID audit
at 1791348764 found all 52 allocated Machines and 52 Volumes absent, with zero
exact owner claims. The first and fourth intermediate counts retain original
observation receipts rather than an invented surviving raw snapshot.

## Diagnosis

All 50 primary native terminal records followed the last local child marker.
Two autoscaler workers had already been retired earlier, and one unsuccessful
clone attempt was not allocated. The final native cohort was therefore 50
primaries, not all 52 allocated resources. Its sorted original native receipts
show thirteen bounded-four waves (twelve full waves and one pair); their maxima
run from 1791348144.964301 to 1791348503.806091. The existing native reaper was
already bounded parallel with default four. Raising concurrency is not the
identified repair.

The original actual child supervisor writes benchmark-child.finished only after
run-bench-cloud exits through guest ACK, complete runtime capture, local proxy
cleanup, and runner-group extinction. Yet it then schedules no native work.
The controller joins every child, waits for global autoscaler finalization,
performs final acceptance/aggregation, and enters EXIT cleanup before any
primary can enter that existing exact-record reaper. This couples each scope's
physical lifetime to the slowest independent peer. By epoch 1791347000, 29
children had finished; counts were 35 at 7200, 40 at 7400, 43 at 7600, 47 at 7800,
and 49 at 8000 (all epochs share prefix 179134). These counts show opportunity;
they do not prove every scope was already eligible for early native release.

All 50 original autoscaler completed-after-child markers match their respective
child return codes, with producer-write lags of 0.012510 to 0.376367 seconds.
The original run did not preserve a separate early PID/birth-absence receipt.
A completion marker alone cannot prove the autoscaler EXIT jobs are joined, nor
that active worker dependencies no longer need their primary backend/PG.

The smallest owning reproduction invokes the unchanged real collector
supervisor while an independent sibling remains alive. It requires a sealed
primary retirement handoff and preserves normal task FAIL exit 1. The exact
command failed on the original runtime (one FAIL, 1.71 seconds) and passed on
the isolated candidate (one PASS, 0.37 seconds) without changing its assertion.
Separate existing-family controls exercise actual full primary manifest
validation, atomic registry admission, the extracted unchanged native reaper,
Bash 3/5 permits, and cancellation. The final related family was 41 PASS in
9.82 seconds. Test elapsed times are fixture measurements, not cloud latency
or benchmark outcome proof.

Archive searches were `provider-teardown-verified destroyed-provider-retained
run-bench-fleet` and `slow teardown serial machine volume cleanup parallel
release`. The related 2026-10-05 normal-fleet-retirement case fixed serial
per-record native cleanup, and that bounded-four fix is present here. This is a
related stage-coupling cause, not a demonstrated recurrence of its peak-one bug.

The 18-second post-native tail is a measured composite boundary. Source shows
post-release projection, final Hub upload, and lifecycle serialization there,
but no retained producer timestamp establishes the HTTP upload's exact start
and finish. Per-native-call timings are also unavailable. Neither interval is
assigned to an unmeasured provider or HTTP operation.

## Solution

An isolated candidate unifies the original exact native per-record state
machine into one shared function and permits an already completed collector
supervisor to submit its own sealed primary through the same bounded-four
mechanism. It does not raise native parallelism or change tasks, prompts,
models, evaluator, grades, the 1200-second task window, or normal autoscale 15.

Eligibility requires the original matching guest ACK, full stopped-service and
runtime hash manifest, no pending capture, a matching causal autoscaler marker
and positively absent recorded PID/birth, empty current worker ledgers, no
pending workers, complete original historical worker evidence, and exact
terminal receipts for every historical worker allocation. Active workers remain
on the unchanged final fleet capture/readiness path. A missing seal, unknown
birth, pending native disposition, or unavailable index preserves allocation.

The existing whole-cohort disjointness check runs once before the early path.
An owner-local index is seeded from the original expected/fresh receipts and
provides atomic, immutable Machine and Volume identity claims at the existing
name/volume/Machine registration boundaries. Own-source entries and monotonic expected child cardinality establish worker
coverage without scanning the whole registry for each primary. Cardinality is
committed before membership so missing or truncated group/claim state retains
the primary. The immutable catalog name-to-ordinal bindings are generated once
from the original catalog with its unchanged 1 MiB ceiling; retirement reads
only its own bounded row. A realistic 10,000-entry name/mode catalog control
records exactly one full catalog open during initialization and none during
early retirement. Its actual final fixture invocation took
2.638250 seconds, with the pytest root positively reaped and its original birth
absent afterward; this is a local fixture measurement, not a cloud forecast. Unindexed or
unproved scopes remain on the original final path. Existing fleet quarantine
sentinels, exact recovery compatibility, final whole-owner audit, capacity/claim
release, registry removal, grades, and lifecycle seal remain authoritative.

Cancellation uses the existing complete-tree birth-bound join. Permit reset
requires both the positive join and return of every permit. An actual lost
permit after KILL retains ownership and refuses final native admission; normal
TERM returns permits and can proceed. Inverse controls cover running siblings,
missing/pending evidence, active autoscaler/worker, missing historical capture
or owner, duplicate initial and worker Machine/Volume, pending native cleanup,
normal task FAIL, TERM, and KILL. Both Bash versions passed syntax checks.
Independent review caught an omitted worker index claim permitting early
delete; the same two missing-claim/group inverses were RED (2 FAIL, 2.32
seconds) then unchanged GREEN (2 PASS, 0.48 seconds). Exact native fixture
root/descendant PID births and post-join states are retained privately. The
peer freshly observed all twelve original recorded births absent at epoch
1791351066 across the four Bash 3/5 TERM/KILL controls.

At 10,000 scopes, index initialization is O(N), admission uses constant-size
locked identity files, each terminal primary reads only its own worker group,
and new early-primary/final-registry native operations remain bounded at four.
The existing in-run autoscaler worker cleanup remains unchanged; no total
provider-call peak of four is claimed. The original final whole-owner
audits remain mandatory. There is no new per-child whole-registry rescan or
unbounded provider process pool.

Golden references read: OpenClaw src/process/supervisor/supervisor.ts:113 and
:154 retain admission through per-scope cleanup and join selected extinction
promises; Claude Code src/tasks/LocalShellTask/LocalShellTask.tsx:222 calls
flushAndCleanup before marking its own task terminal; Hermes
 tools/process_registry.py:1114 flushes and reaps each owned process before
recording completion. These support per-scope lifetime ownership and positive
joining, but none of those reads establishes a cloud-native retirement analog.
Codex was absent at the known local reference paths, so no Codex analogy is
claimed; the offline scope excludes a new source fetch.

Status remains open pending adversarial review, Tank integration, and a fresh
immutable ordinary LIVE run. No new fleet/build/provider calls were made, and
no cloud speedup, benchmark PASS, or acceptance credit is claimed.

## Human feedback

Root explicitly limited the work to offline diagnosis and an isolated candidate,
with Tank as the sole integration owner. Root required unchanged native four,
real guest/runtime/worker authority, no child-finished-only or PID-only proof,
no new timeout or grade changes, no O(N²) audit scans, atomic Machine/Volume
collision fencing, and positive cancellation joining before permit reset.
The concluded 1c557 run must remain immutable. Root also required preservation
of all original stage origins and explicit unknown HTTP/native substep clocks.

## Reusable lesson

Retire an independently sealed scope through the existing exact native state machine only after all of that scope's dependencies and durable evidence are proven, while retaining the final whole-owner audit.
