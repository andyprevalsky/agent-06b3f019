---
id: 2026-10-14-autoscaler-fixture-partial-health-publication
date: 2026-10-14
title: Offline autoscaler fixture exposed partial inventory health during restoration
surface: infra
component: benchmark-autoscaler-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: worker_capacity_loop_test restored the live inventory health file by truncating it before writing the complete record, unlike the production publisher's atomic generation swap
symptoms:
  - autoscaler-exited-before-control-boundary
  - shared provider inventory is unhealthy during the run
  - worker capacity loop receipt failed aggregate assertion
tags:
  - autoscaler
  - fixture
  - publication
  - inventory
sources:
  - commit f7ca80696cd6cef58f524eda77c973c04f94d09d
  - PR #1506 ecaed61aa existing atomic-health publication and slow-writer hunk
  - PR #1491 2819fe4f6 same existing hunk
repro: agents/benchmarks/worker_capacity_loop_test.py
status: open
---

## Problem

The deployment's second agent coverage run failed the permanent autoscaler
handoff group: 47 tests passed and one failed in 54.37s; its capacity loop
receipt passed nine of ten modes with all recorded owners absent. The original
per-mode receipt under pytest-26 was removed by pytest retention. The stored
benchmark log at .context/test-runs/agents-coverage-20261014-192042-1024970/benchmark.log
contains aggregate counts and pytest's abbreviated assertion,
so the original failing mode is unknown. Three ordinary unchanged-source
replays passed all 48 tests in 54.27s, 53.68s, and 53.36s. No conclusion about
load or the original historical mode follows from those passes.

## Diagnosis

A reproducible defect exists at the fixture publisher boundary. The test
restores inventory/current/health with Path.write_text, which truncates the
live record before publishing its complete token and deadline. The production
producer writes a complete generation and uses os.replace to publish current.
The real inventory consumer correctly treats an empty existing health record
as fatal ownership corruption; it treats missing/expired observations as
pending. Exposing a partially written restore changes the fixture's intended
transient-availability recovery into fatal invalid ownership.

The request path is fixture health restore -> extracted inventory_index_healthy
-> inventory_machine_exists -> real bench_autoscaler -> native child cleanup
-> per-mode receipt -> permanent owning gate. Under the identical isolated
0.2-second writer scheduling control, unchanged buggy source fails both
inventory_expired_then_ready and inventory_read_miss_then_ready: autoscaler
returns 1 before the independent child finishes and before desired capacity
is observed, with durable reason "shared provider inventory is unhealthy during
the run". The same 48-test command passes after only sibling-temp-file write
and atomic replace. Candidate red/green extracted source bytes are identical, SHA256
b4fab90d0bc1546341bc6c57dd28069573b87b43059e76282acf176c0fff5e7e.
The original-source packet has SHA256 8c8278ca7e40ce4f62eee3372ee529680f7228ef85d1a9070f8d49fbd4b0aa1b:
only its first-line absolute fixture helper path differs. Removing that
source-library path line yields identical bytes, normalized SHA256
a6b3f956a34eb78982d6b25981bffe46115b64fabe43c69cc2884e28e9cd052a.
The historical 9/10 result remains a separate unreproduced observation.

Archive searches for literal assertion categories and autoscaler metrics/recovery
found the post-ready-observation case and live-inventory-freshness case as
related machinery. Searches for "inventory health fixture atomic truncate
publication" and "worker_capacity_loop_test slow_health_write temporary_health"
found no same-boundary archived case. Open PRs 1506 and 1491 already carry the
same repair. Reuse that narrow hunk; do not merge unrelated PR content.

## Golden reference and simplification

The existing producer scripts/cloudbench-machine-readiness.py:242 writes health
inside a private generation, then line253 publishes current using os.replace.
Independent read-only reference checks also found complete-temp-then-rename
publication in claude-code-src/src/utils/file.ts:385, sibling replacement in
openclaw/scripts/swift-build-cache-metadata.py:142, an explicit polling-empty-ACK
repair in hermes-agent/cron/scheduler.py:3935, and sibling write-and-replace in
codex/codex-rs/windows-sandbox-rs/src/file_write.rs:56. The fixture needs atomic
visibility; this fix does not claim crash durability. The external search
"site.docs.python.org os.replace atomic successful same filesystem" located the [official Python3.11 os.replace documentation](https://docs.python.org/3.11/library/os.html#os.replace), which supports sibling replacement as an
atomic filesystem publication. This reference is a design check, not causal
proof. The smallest fix removes in-place mutation of the exposed record;
no additional consumer branch, retry path, or altered contract is needed.

## Solution

Make the fixture obey its real producer's atomic-publication contract: write the
fresh health record to a sibling temporary file, then replace health atomically.
Keep a slow health writer in the existing permanent owning test so the former
partial-publication window fails deterministically. Preserve all 36 original
assertions, modes, product limits, fixture guard, polling intervals and cleanup
behavior. Include failed mode/error/scaler return code in the printed receipt
summary so the owning persisted log retains the causal boundary even if pytest
abbreviates assertion details and deletes temporary files.

The narrow production consumer and autoscaler behavior remain unchanged; invalid
publisher ownership still fails. No network, model or provider calls occur.
All captured native Popen children were reaped and recorded owners were absent.
No production cards, sessions, fleets, environment variables, or Freedom state
were changed.

## Evidence

The existing permanent gate remains registered by
agents/tests/blackbox/benchmark.blackbox.py:637 as
 test_autoscaler_runtime_handoff_is_in_permanent_gate; its native 48-test command
 includes this owning test. The benchmark blackbox runner records that gate as
 autoscaler_runtime_handoff_permanent_gate and agents coverage runs the blackbox
 runner. No extra suite or deployment gate was introduced.

Private packet root: .context/capacity-loop-investigation. Three baseline log
files and complete baseline-1/2/3-artifacts retain ordinary buggy-side controls.
candidate-red.private.log and candidate-red-artifacts retain controlled failure;
candidate-green.private.log and candidate-green-artifacts retain controlled pass.
The exact command in the private candidate tree is:

```bash
python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py agents/benchmarks/worker_capacity_loop_test.py agents/benchmarks/cloudbench_campaign_barrier_test.py -k "autoscaler_runtime_handoff or campaign_start_barrier"
```

Both controlled runs activate the same venv and identical private scheduling
plugin. Controlled red exits 1 with 47 passed/1 failed and 8/10 modes; controlled
green exits 0 with 48 passed and 10/10 modes in 53.93s. The ordinary atomic candidate run with the plugin removed passed 48/48 in
53.52s with all 10 modes passing and native owners absent. Permanent stress
on its own, without the external plugin, failed on the non-atomic fixture in
14.55s: the same two transient inventory modes failed (8/10), with precise
failed_cases present in stdout and native owners absent. Permanent green passed the same unchanged native test command in 14.57s
(10/10 modes, all owners absent). Final permanent 48-test group passed in 53.82s (48 passed, 932 deselected),
with all 10 modes passing, all Popen children reaped and all recorded native
owners absent. Permanent-control.private.patch passes
git apply --check against the shared deployment revision.

Integrated source `010f53d294eddad4c56c8d6cf1a3d424ca10c9a3` then passed
all 110 agents blackbox domains under coverage, including the benchmark domain
in 214.28s. This is source-bound full-runner verification; it does not establish
the missing historical 9/10 failing mode or close that outcome-reproduction gap.

## Human feedback

None recorded for this incident. Standing RCA/deployment instructions forbid
weakening caps, timeouts, assertions or contracts.

## Reusable lesson

Publish fixture records atomically and retain per-mode failure details in the
owning run log.
