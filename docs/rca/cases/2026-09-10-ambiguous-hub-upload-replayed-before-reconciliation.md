---
id: 2026-09-10-ambiguous-hub-upload-replayed-before-reconciliation
date: 2026-09-10
title: Required Hub upload replayed an ambiguously committed POST before reconciling visibility
surface: harness
component: benchmark-hub-upload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/benchmarks/hub_upload.py::_post_run_bundle — a retryable POST response failure replayed the mutation without first checking whether the exact run was already visible"
symptoms:
  - "TimeoutError: The read operation timed out"
  - "HubVisibilityError: benchmark Hub upload failed: The read operation timed out"
  - "benchmark Hub upload attempt 1/4 failed transiently"
  - "capability stability proof failed at slice 0 before provisioning"
tags:
  - benchmarks
  - hub
  - retry
  - timeout
  - ambiguous-commit
sources:
  - fleet run capability-stability-20260910194757-3871841
  - commit 0249b6df8
  - commit 3b880f2b7
repro: agents/tests/blackbox/benchmark.blackbox.py::test_hub_registration_recovers_ambiguous_committed_post_timeout
status: fixed
---

## Problem

The exact capability proof
`scripts/run-bench stability-proof -k 10 --concurrency 10 --seed 20260910
--timeout 300` aborted slice 0 before provisioning. Its slice log recorded four
30-second POST response-read timeouts and then
`HubVisibilityError: benchmark Hub upload failed: The read operation timed
out`. The proof summary classified the only slice as `infra`.

The supposedly failed STARTING registration had actually committed. This exact
read-only command passed after the failure:

```
BENCHMARK_HUB_UPLOAD_URL=https://navi-j9a9.onrender.com \
  agents/venv/bin/python agents/benchmarks/hub_upload.py \
  --verify-visible 20260910-194757-3871854
```

It printed `in-app Benchmark Hub registration verified` for the same run ID.
The target was intentionally production: the controller's local central Hub is
a static diagnostic dashboard, not the in-app registration API.

## Diagnosis

Critical path:
`run-bench-fleet require_in_app_hub_visibility` → `hub_upload.py
--require-visible` → `_post_run_bundle` POSTs the live STARTING card → backend
persists the run → the client waits for the HTTP status line → the read deadline
expires → `_post_run_bundle` retries the POST four times → the final exception
prevents `require_run_visible` from calling `verify_run_visible` → the fleet
classifies INFRA before provisioning.

The first bad boundary was the required live upload retry loop. A response-read
timeout proves only that the client did not receive an acknowledgement; it does
not prove that the server rejected the mutation. The old loop nevertheless
treated every retryable transport failure as an uncommitted POST and postponed
the exact-run visibility read until after `_post_run_bundle` returned
successfully—an impossible point in this incident.

The deterministic blackbox commits `blackbox-ambiguous-commit` in a local HTTP
handler, withholds the POST response beyond the client deadline, and keeps the
exact-run GET responsive. On the buggy implementation, this unchanged command
made four POSTs and exited 1 with `HubVisibilityError`:

```
PYTHONPATH=agents/tests/blackbox:agents agents/venv/bin/python -c \
  'import importlib.util; spec=importlib.util.spec_from_file_location("benchmark_blackbox", "agents/tests/blackbox/benchmark.blackbox.py"); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.test_hub_registration_recovers_ambiguous_committed_post_timeout()'
```

The fixture payload is 149 bytes and the live STARTING card was 2,183 bytes, so
payload size was rejected as causal. The exact post-incident GET rejected
"server never committed", and the explicit production base plus the in-app
contract rejected "wrong Hub target".

Step 5a stops at the owned retry/reconciliation contract: mutating HTTP clients
must resolve an unknown outcome through the operation's exact read identity
before replaying or failing. The next why is why the production server took
longer than the client read deadline; that is not required to explain the false
failure because the owned protocol must remain correct for connection resets,
gateway timeouts, and delayed acknowledgements after any successful commit.

Archive searches for `The read operation timed out HubVisibilityError benchmark
Hub upload failed` and `STARTING report card POST committed response timeout
retry visibility` found the 2026-08-12 local-smoke Hub case as a relative, not a
recurrence. That case selected the wrong prod target for local smoke; this fleet
selected its intentional target and violated the ambiguous-write contract.

## Solution

After any retryable exception from a required live POST, `_post_run_bundle` now
performs a bounded `verify_run_visible` for that exact run ID. Visibility is
success: execution continues without replaying the mutation. A missing,
unreadable, or mismatched run preserves the existing bounded retries and final
fail-closed `HubVisibilityError`.

The identical focused command now exits 0 after one timed-out POST, one
successful reconciliation GET, and exactly one POST. The deploy-owned runner
also passed:

```
cd agents && venv/bin/python scripts/run_blackbox_tests.py benchmark
```

Result: `1 passed, 0 failed`. The checked-in regression covers delayed
acknowledgements and also protects connection-reset/gateway-error siblings where
the exact run committed before the transport failed.

Delete/unify could not remove required in-app registration or its fail-closed
visibility proof. The guard is therefore at the single upload owner and reuses
the existing exact-run read contract. At 10,000 agents it adds no per-agent
polling or shared state: one run-scoped GET occurs only after a retryable live
registration failure, bounded by the existing four attempts.

## Human feedback

The user required a deterministic isolated reproduction at the owned HTTP
upload boundary, a general fix and permanent regression without weakening
fail-closed visibility, and the exact sequential 10-slice × 10-task proof with
the unsaved 300-second timeout. Benchmark definitions, task criteria, prompts,
and benchmark timeouts were not to change.

## Reusable lesson

Reconcile an ambiguously failed mutation through its exact read identity before replaying it or declaring the operation failed.
