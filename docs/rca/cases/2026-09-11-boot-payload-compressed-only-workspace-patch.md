---
id: 2026-09-11-boot-payload-compressed-only-workspace-patch
date: 2026-09-11
title: Cloud boot transport compressed the workspace patch but left every bootstrap helper uncompressed
surface: agents
component: cloudbench-boot-transport
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud assembled uncompressed bootstrap helpers beside a compressed patch in the size-limited machine update
symptoms:
  - "machine-config payload is 909284 encoded bytes, over the 900000-byte ceiling"
  - "exited without a ready marker (0/2 ready)"
tags:
  - cloudbench
  - boot
  - compression
  - provenance
sources:
  - PR #1299
  - fleet run 20260910-235904-50539
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_launch_compresses_complete_payload_under_provider_ceiling
status: open
---

## Problem

The exact Polar cancellation rerun never reached task execution. Its mandatory
two-task infrastructure canary cloned two Machines, then both controllers refused
the same oversized boot payload. Neither task started. The failed canary and
parent remain failed; exact provider inventory and volume reads independently
verified both owned Machines terminal and both owned volumes pending destruction
and unattached. Both ownership registries were retired.

## Diagnosis

Both `fleet-child.log` files report 909284 encoded bytes against the unchanged
900000-byte ceiling. The workspace patch contributed 487588 encoded bytes. The
rest comprised current bootstrap scripts and execution provenance. The existing
transport compressed only the patch, so adding current controller helpers still
expanded the machine-config body. The guard correctly rejected this before the
provider update; there is no observed provider body rejection in this incident.

The local regression executes the actual controller file-argument assembly and
size guard, with the captured patch's encoded size represented by deterministic
incompressible bytes and current helpers/provenance. It failed at 905564 bytes
before the fix. The reduced fixture differs from the live provenance size, but
reproduces the same refusal before the launch boundary. The identical command
passes after the fix and unpacks and byte-compares every enveloped helper, provenance
file, and patch:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k boot_launch_compresses_complete_payload --tb=short`

Private receipts: `.context/acceptance/boot-payload-valid-repro-before.log` and
`.context/acceptance/boot-payload-repro-after.log`. The earlier fixture omitted
provenance and failed on an absent new-format field; that was a fixture error,
not causal proof. Additional permanent tests reject checksum failures, truncated
gzip, malformed schemas, path traversal, entrypoint replacement, empty entries,
and malformed base64 before modifying any helper. A real boot failure replay
checks the current-token no-launch acknowledgement and terminal state.

Archive searches used `request body too large boot.config oversized patch` and
`compressed patch machine payload boot payload`. The July 16 per-box launch SSH
case and word-split inline boot case are relatives: they explain why boot files
must remain in the one-update transport. The existing September 8 code comment
records the prior patch-only compression fix; this recurrence exposes its
incomplete scope. No separate archived case for that patch compression was found.

## Solution

Package all non-entrypoint injected files into one deterministic gzip JSON
envelope. Keep the boot supervisor, dependency-free decoder, and status server
outside the envelope. Verify the compressed SHA and validate all filenames and
contents before atomically materializing each original file with identical bytes. An
unpack failure remains observable through the status server, acknowledges that
no browser/driver launched, and seals the guest without running checkout code.

The fleet snapshots and seals the decoder alongside its other control scripts.
Existing patch compression, transport/plaintext checksums, requested source,
execution provenance, 900000-byte limit, five-minute validation budget, and all
readiness/evidence bounds remain unchanged. The normal benchmark backstop stays
120 minutes. The SSH path retains its independently staged helpers.

This fixes the transport class for every injected non-entrypoint file. Excluding
source files from the patch would alter what is tested; relaxing the ceiling
would discard the failure signal. Moving bulk launch back to per-guest SSH would
reintroduce the archived API saturation failure. At fleet width this adds local
linear compression/decompression work and no provider calls or resource count.

The owning controller regression suite is invoked directly by `/deploy` and by
a registered benchmark blackbox case that executes all nine new scenarios.
Twenty-two affected controller cases pass on both macOS and Linux. Live canary
and exact Polar verification are still required, so this case remains open.

## Human feedback

The user requires ten sequential cloud slices of ten real tasks with zero
infrastructure errors, no repeated permission requests, and a temporary
five-minute execution limit while retaining normal 120-minute backstops.

## Reusable lesson

Measure and compress the complete boot payload; a compressed patch does not bound the uncompressed bootstrap files beside it.
