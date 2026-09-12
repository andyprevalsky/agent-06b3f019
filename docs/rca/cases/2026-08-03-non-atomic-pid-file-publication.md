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
  - "JSONDecodeError: Expecting value: line 1 column 1 (char 0)"
  - test_boot_payload_fixture_cleanup_without_proc_reaps_detached_children failed
tags:
  - benchmark-harness
  - process-groups
  - pid-file
  - atomic-publication
  - cleanup
sources:
  - PR #924
  - PR #1299
  - commit 2b5c803e4b41f9869427d7c093c2abfb78b1f258
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

### September 11 recurrence in boot cleanup fixtures

The agents coverage gate on `2b5c803e4` passed 99 domains and failed the
benchmark domain when its boot cleanup fixture parsed `children.json` as an
empty string at `cloudbench_dependency_sync_test.py:1506`. The neighboring
reused-identity fixture had the same direct final-path write followed by
existence polling and integer parsing. The original fix covered a different
fixture; these newer producers repeated the same incomplete publication
protocol. This is a recurrence of the contract, not a provider failure.

Archive searches used `JSONDecodeError Expecting value children.json` and
`fixture ready empty file atomic publication`; a literal search for atomic
readiness and JSON errors found this case. The registry-retirement case is a
relative with a different boundary: disappearance after complete publication.

The critical path is child launch → final file opened → parent observes
existence → parent parses incomplete PID payload → cleanup test fails before
its intended assertion. The observed empty JSON establishes the first bad
data boundary. An explicit 200 ms open/write interval makes the same window
deterministic in both fixtures. The unchanged test command
`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k boot_payload_fixture_cleanup --tb=short`
failed all three cases before atomic publication: two JSON decode errors and
one empty-integer error. After the publication fix all three pass with the
same delay, five-second readiness deadline, identity checks, detached-child
assertions, and unrelated-process survival assertion. Logs are
`.context/acceptance/fixture-ready-publication-rca/unified-before.log` and
`unified-after.log`; the original full-gate traceback is `runtime-failure.log`.

## Solution

The fixture now opens a sibling `.tmp` path, retains the adversarial 200 ms delay,
writes and closes the complete PID, then atomically renames the file onto the
readiness path. The focused reproduction passed with that same delay, and the
full benchmark blackbox subsequently discovered and passed the test. This
prevents every consumer of an existence-based fixture handoff from seeing a
partial PID. It is test-only O(1) filesystem work and adds no runtime process,
lock, scan, or per-agent cost at 10,000 agents.

The boot fixtures now share `_boot_fixture_ready_program`, which retains the
adversarial delay while writing a sibling temporary file, closes it, then
renames it to the readiness path. One producer owns the absent-to-complete
transition for both JSON and integer payloads; no parser retries or timeout
relaxation are needed. Cleanup before successful payload parsing reuses the
existing process-tree owner while its `Popen` root is still live. `ExitStack`
ensures a tree-inspection error cannot skip captured native-identity cleanup
or the remaining owned parent/sentinel joins. The intentional reused-identity
case still refuses to signal the replacement; final test cleanup uses its
separately captured actual native identity.

Independent review identified the sibling producer and the cleanup-error
join hazard before finalization. The three cases are already discovered by
the benchmark blackbox in agents coverage and by the controller deploy gate.
This fixture correction adds no production work or paid benchmark executions.
The full fresh deployment loop and separate cloud outcome proof are still
required; the local publication regression supplies no cloud acceptance credit.

## Human feedback

None recorded for the original incident. During the September recurrence the
user required continued execution without repeated permission requests, ten
sequential ten-task cloud slices with no infrastructure outcomes, and a
temporary five-minute execution limit while preserving the normal 120-minute
backstop. This fixture fix changes none of those bounds or acceptance rules.

## Reusable lesson

Publish readiness files with write-close-rename so existence and a complete payload become visible atomically.
