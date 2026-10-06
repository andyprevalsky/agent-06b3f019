---
id: 2026-09-30-origin-memory-fixture-jsonb-aggregate-exhausts-docker-vm
date: 2026-09-30
title: Origin-memory fixture construction exhausted Docker VM memory before the injection child started
surface: back-end
component: browser-origin-memory-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The 540000-record fixture retained a nested jsonb_agg object accumulator in PostgreSQL before testing production injection
symptoms:
  - "Server has closed the connection P1017"
  - "server process (PID 4057) was terminated by signal 9"
  - "FATAL database system is in recovery mode"
tags:
  - postgres
  - jsonb
  - fixture-memory
  - docker-vm
  - coverage
sources:
  - PR #1299
  - commit 9d44d054cae4ed89eea11c6a469697a881583683
repro: back-end/src/tests/blackbox/browser-origin-injection-memory.blackbox.ts
status: fixed
---

## Problem

Canonical backend coverage returned one after 387.533 seconds. Its two failed
domains were `browser-origin-injection-memory` and `steel-injection`; the latter
failed nine credential cases when PostgreSQL rejected new connections during
recovery. The other 393 unit-file/domain result entries passed. The original
failed aggregate is preserved and is not relabeled.

## Diagnosis

At 06:16:03.185 UTC, PostgreSQL reported that server PID 4057 was killed by
signal 9 while executing the fixture's `INSERT INTO IndexedDBOrigin`. The logged
query identifies the `DocsErrors` / `Errors` record generator and its nested
`jsonb_agg`; the treatment child had not started. PostgreSQL terminated sibling
connections, rejected eleven connections during recovery, and accepted
connections again at 06:16:04.612 UTC.

The exact owned container reported an OOM kill, `memory.events` recorded one
`oom_kill`, and its cgroup peak was 5,870,743,552 bytes. Its memory limit was
unbounded within an 8,321,150,976-byte Docker VM shared by eleven containers.
Native Docker logs record an OOM event at the same instant. The post-recovery
memory sample showed approximately 108 MiB free in the VM's 1 GiB swap; this is
not a measurement of swap availability at the instant of failure. No unrelated
container was stopped, reconfigured or cleaned up, and the database was not
reset.

The first bad boundary is test-data construction in PostgreSQL, rather than
production `injectUserData` transfer. The fixture aggregated the full nested
JSONB object graph before wrapping it in the database/store envelope. The
archive search `database system in recovery mode OOM PostgreSQL coverage`
found the related September 27 shared-host JSONB fixture OOM. Its Linux swap
remediation does not prove a remedy for this occurrence. The browser-origin
production memory case remains a separate case, with its original live OOM
outcome gap unchanged.

## Solution

Only the fixture construction changes: aggregate each serialized record as text
in numeric order, then parse the complete envelope into JSONB once. The fixture
still contains 540,000 records and 78,617,865 canonical bytes. It retains the
512 MiB treatment heap, 1200 MiB Node RSS assertion, 1 MiB script assertion,
15-second injection phase and all existing owning assertions. Added exact
record-count, byte-count and canonical digest assertions prevent the new
construction from silently weakening the fixture.

Bounded read-only old/new SQL probes matched canonical digest, byte count and
record count at 1,000 and 54,000 records. An independently streamed reference
for all 540,000 original records matched the final construction's canonical MD5
`9e9427f49de602f7a41fffc175aec0d8` and full byte count. A second full SQL control
using the original record expression and `jsonb_agg` in bounded 54,000-record
chunks matched that same digest, count and byte count. This is a content
comparison, not a repeat of the unsafe original single-shot accumulator.
The full candidate SQL
completed in 2.519 seconds with a sampled PostgreSQL RSS peak of 1,964,192 KiB;
minimum VM available memory was 4,635,280 KiB. Its private safety guard did not
cancel the query. The original full accumulator was not repeated after its
actual OOM, to avoid harming unrelated VM workloads.

The same final formatted fixture then exercised the real production boundary
under Node 22.13.0 with actual V8 coverage enabled. Against original d4c3d87
injection, it failed the unchanged RSS assertion at 1241.469 MiB in 5.672
seconds. Against current production, it transferred all canonical bytes and
passed at 535 MiB in 8.070 seconds. The baseline used a positively verified
private module-resolution override only; the final test's bytes were identical
in both runs. An earlier ESM override failed to intercept CommonJS loading and
is retained as an invalid baseline attempt, not red evidence.

The unchanged Steel domain then passed all ten assertions in 30.616 seconds
with no recovery errors. This confirms the downstream failures clear after
recovery; the final concurrent gate remains the outcome proof.

The canonical concurrent backend coverage rerun then passed in 353.484 seconds:
172/172 blackbox domains, all unit checks and the unchanged coverage thresholds.
It used the same owned database without resetting it and the original worker
limits. All 1,530 recorded backend source inputs remained unchanged during the
run. Typecheck and focused lint/format checks also passed. The private final
receipt is `proof85-backend-coverage-repaired.final-verified.private.json`.
Root independently reviewed the fixture, content equivalence and owning proof.
This closes the test-fixture failure; it does not close the original live guest
OOM investigation. No production
injection, PostgreSQL setting, VM allocation, task, model, prompt, evaluator or
acceptance rule changes here.

Private source, native logs, memory samples, SQL probes and unchanged owning
red/green receipts are retained under
`.context/acceptance/proof85-backend-pg-recovery-rca/`.

## Human feedback

Keep the exact large fixture and its permanent memory bound. Prove the repaired
fixture still fails original production and passes current production. Diagnose
the owning failure before rerunning, and avoid broad additional verification
or unrelated resource cleanup.

## Reusable lesson

A memory regression fixture must avoid constructing an even larger object
graph in its database prerequisite. Preserve canonical data and the production
bound while repairing that construction path.
