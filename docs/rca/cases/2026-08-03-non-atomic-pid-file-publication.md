---
id: 2026-08-03-non-atomic-pid-file-publication
date: 2026-08-03
title: Benchmark cleanup fixture published PID-file readiness before the PID payload existed
surface: agents
component: local-benchmark-service-cleanup
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tests/blackbox/benchmark.blackbox.py child fixture used Path.write_text directly on the readiness path
symptoms:
  - "ValueError: invalid literal for int() with base 10: ''"
  - local_start_services_exact_process_group_cleanup failed
tags:
  - benchmark-harness
  - process-groups
  - pid-file
  - atomic-publication
  - cleanup
sources:
  - PR #924
repro: agents/tests/blackbox/benchmark.blackbox.py test_local_start_services_reaps_only_its_real_process_group
status: fixed
---

## Problem

The canonical agents coverage runner passed 89 tests and failed
`local_start_services_exact_process_group_cleanup`. Its log showed
`ValueError: invalid literal for int() with base 10: ''` while converting the
contents of `child.pid` to an integer. The fixture's readiness loop had already
observed that the path existed, yet the subsequent read returned an empty
string. A focused reproduction made the publication window deterministic by
opening the final path, waiting 200 ms, then writing the child PID; the unchanged
test failed at the same conversion.

## Diagnosis

The production cleanup code had not selected or killed the wrong process. The
first bad value was created inside the test fixture: `Path.write_text` opens the
final path before writing its contents. The parent treated `Path.exists()` as a
complete readiness protocol, so it could enter cleanup during that open/write
window, terminate the fixture process, and then parse the permanently empty
file. The deepest owned cause was a two-state handoff (absent/present) being
implemented as two non-atomic mutations (create/write), so path existence did
not imply a complete payload.

## Solution

The fixture now opens a sibling `.tmp` path, retains the adversarial 200 ms delay,
writes and closes the complete PID, then atomically renames the file onto the
readiness path. The focused reproduction passed with that same delay, and the
full benchmark blackbox subsequently discovered and passed the test. This
prevents every consumer of an existence-based fixture handoff from seeing a
partial PID. It is test-only O(1) filesystem work and adds no runtime process,
lock, scan, or per-agent cost at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Publish readiness files with write-close-rename so existence and a complete payload become visible atomically.
