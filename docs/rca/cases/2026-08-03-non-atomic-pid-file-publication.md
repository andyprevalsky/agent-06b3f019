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
  - "invalid bench log generation"
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
  - PR #1745
  - PR #1752
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

### September 12 recurrence in recording and setup fixtures

The next native coverage gate on `9297fc6d3` passed 99 domains and failed
`recording-archive`: the parent parsed `main-returned` as empty JSON. The worker
opened the final readiness path before writing its timestamp. The actual
unchanged blackbox, with a 200 ms publication window made explicit, failed
one of five checks before the fix and passed all five after writing a sibling
temporary file and renaming it. Recording encryption, HTTP archive, supervisor
shutdown assertions and all original deadlines remain unchanged. Evidence is
`.context/acceptance/fixture-ready-publication-rca/recording-runtime-failure.log`,
`recording-before.log`, `recording-after.log`, and `recording-current-after.log`.

An audit found the same protocol in case 10 of
`scripts/tests/setup-db-concurrency.test.sh`: the parent polls `child.pid`
existence then immediately parses its contents. Running the actual generated
child program with the same 200 ms open/write interval failed with an empty
integer. The identical producer replay passed after atomic publication, and
the full unchanged ten-case shell suite passed. The delay remains in that
existing deploy-owned case to expose future direct-write regressions. Its
artifacts are `setup-db-producer-repro.py`, `setup-db-before.log`,
`setup-db-after.log`, and `setup-db-full-after.log` in the same evidence folder.
The earlier fix held for its producers but did not cover these independently
implemented handoffs; these are fixture contract recurrences, not evidence of
provider or database cleanup failure. No production behavior or timeout changed.

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

### October 1 recurrence in the native status server

PR #1299 review finding 4153604581 identified another producer with the same
create-before-write protocol: `cloudbench-status-server.py` opened the final
`bench.log.generation` path with `O_EXCL`, then wrote its token. The existing
shutdown fixture covered normal startup and ownership checks, but never paused
this publication boundary. Searches for `invalid bench log generation` and
`generation non atomic publication crash concurrent`, followed by the literal
atomic-publication archive, identified this recurrence. Earlier fixes protected
their fixture producers; the production status server repeated the class.

The new compact control in the existing shutdown fixture runs the actual server
and intercepts only the filesystem create boundary. Killing the writer before
its first write leaves a final empty file; starting a second server while the
writer is paused exposes that same empty file. Both actual restarts fail with
`invalid bench log generation` on unchanged 9d6 source. This is a controlled
owning reproduction of a review finding, not attribution of a live fleet failure.

The fix writes, flushes and fsyncs a private sibling file, then publishes it with
a non-replacing hard link. Concurrent losers read the complete winning token;
normal cleanup removes only the writer's temporary path. Invalid existing tokens
still fail closed. The change adds no retries, global registry, long-lived lock,
log reset, timeout increase or provider call. The durable identity cannot be
deleted or recomputed on every server restart because bounded log readers use it
to detect generation changes; atomic publication is the narrow owner-level fix.

The same fixture checks crash/restart and concurrent publishers through real
HTTP log reads, including matching generation tokens and mode 0600. All previous
shutdown assertions remain unchanged. The initial Mac run passed the new
publication controls after the fix but correctly refused the later Linux-only
`/proc/<pid>/environ` driver check. Native evidence and invocation corrections
are kept separately under `.context/acceptance/proof85-cycle2-findings/`;
only the native unchanged fixture can certify the full shutdown contract.
The identical native full fixture failed in 0.372 seconds and passed in 1.567
seconds after the fix. A separate first native invocation lacked `rg`; that
environmental failure is preserved, and a checksum-verified real ripgrep binary
was supplied only on this isolated fixture PATH. No assertion changed. The
existing root test runner already invokes this file; `/deploy` Step 4cb now
lists the same native command explicitly. Independent review verified the
identical native fixture bindings and separately exercised the actual server's
publication controls and rejection of an invalid existing token. This focused
regression provides no cloud-fleet acceptance credit.

### Recurrence 2026-11-07 (PR #1745 deploy, deploy-command-structural)

`benchmark-live-results[3/6]` failed
`test_fleet_cleanup_releases_emergency_disk_reserve_nested_liability_owner_fences[unrelated-descendant]`
with `ValueError: invalid literal for int() with base 10: ''` at
`nested_pid = int(ready.read_text())`. Its canary callback published readiness
with a plain `printf ... > "$RESERVE_READY"`, which creates the path before the
PID is written, while the test parses on existence. The earlier fix covered the
boot/benchmark fixtures only; this fixture in
`agents/benchmarks/cloudbench_dependency_sync_test.py` was a sibling it missed.
Mechanism repro (`/var/tmp/rca-imsg/race2.py`): plain redirect with a delay →
`FAIL invalid literal for int() with base 10: ''`; write-then-rename → PID read.
Fix: the callback writes `$RESERVE_READY.tmp` and renames it onto the readiness
path; all 7 parametrizations pass. Gate: NOT_INTRODUCED (the PR changed no
cloudbench code; the failure needs only scheduling delay).

### Recurrence 2026-11-07 (PR #1752 deploy, benchmark-live-results[4/6])

`agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_full_http_auth_deadline_and_owned_join[True]`
failed twice under the concurrent structural gate with `ValueError: invalid
literal for int() with base 10: ''` at `pid=int(pidfile.read_text())`. Its fake
`flyctl` child published its PID with `Path.write_text`, and the test polls on
existence. Mechanism repro: the same write shape with a widened create-to-write
window reads `''`. Fix (landed on main as 6670d5723 in parallel; this PR's
equivalent writer-side change was dropped at merge): the reader waits for the
file's content, not just its name. Gate: NOT_INTRODUCED.

## Human feedback

### October 8 recurrence in campaign publisher cleanup fixture

The final campaign-inventory qualification failed one check while 45 passed:
the final-publication cleanup control observed its JSON owner path, then read
an empty document at line 1170. The fixture wrote directly to that path, so
existence preceded a complete PID/child payload. The actual cancellation and
resource-release assertions had not run. This is the same archived publication
contract, not an observed provider failure.

The fixture now writes a sibling temporary file and atomically replaces the
readiness path. Its existing parent/child retirement, unrelated-process
survival, group-state and admission assertions remain intact. Cancellation
uses the existing fixture host guard instead of a separate 15-second limit;
no production or harness timer changed. Final campaign/barrier/uploader
qualification passed 81 checks with one existing skip in 60.12 seconds.
Original private failure evidence is retained. This fixture correction grants
no LIVE execution or production deployment credit.

None recorded for the original incident. During the September recurrence the
user required continued execution without repeated permission requests, ten
sequential ten-task cloud slices with no infrastructure outcomes, and a
temporary five-minute execution limit while preserving the normal 120-minute
backstop. This fixture fix changes none of those bounds or acceptance rules.

## Reusable lesson

Publish readiness files with write-close-rename so existence and a complete payload become visible atomically.


### October 1 recurrence in immutable worker receipts

PR #1299 finding 4155225138 exposed the same create-before-write boundary in
`cloudbench-worker-evidence.py`. The capture process created `stop.json` with
`O_EXCL` before writing its JSON. The live supervisor used existence as readiness,
so a reader between those operations could fail decoding and retire without the
required terminal receipt. Archive searches for partial JSON, atomic receipts,
and `O_EXCL` found the earlier publication cases. This is a reproduced production
protocol defect; it is not evidence that this race occurred in the archived fleet
slice, whose independent review found no hidden internal infrastructure failure.

The existing native supervisor fixture now has one additional parameter. It
pauses the real producer after file creation, before the first write, until the
real supervisor polls that publication window. The unchanged original close,
log-tail, archive and exact-terminal assertions remain. On original source, the
normal control passed and the paused control failed: two cases, one failure in
1.220 seconds. The same test bytes passed after the repair, and the full existing
native file passed 38/38 in 2.674 seconds with no skipped cases. The separate
original owning reproduction also failed in 0.341 seconds and passed unchanged
in 0.457 seconds. Exact test parent and child processes were retired.

The writer now writes and fsyncs a private sibling, then publishes it with an
exclusive native rename: Linux `renameat2(RENAME_NOREPLACE)` or Darwin
`renamex_np(RENAME_EXCL)`. Directory fsyncs remain. A hard-link handoff is unsuitable
here because readers require `st_nlink == 1`, including during publication.
Existing destination files still raise `FileExistsError` and cannot be replaced.
The existing stop-request test checks retained owner contents, single-link mode
0600 and temporary-file cleanup. All 51 original assertions remain. Darwin's
existing 38 cases pass; its supervision cases continue to verify the explicit
Linux-only boundary, while the real subreaper lifecycle runs in the native gate.

Independent review verified the unchanged failing/passing fixture, final source
and test hashes, owner retirement, immutable publication and existing gate
registration. The normal capture deadline remains 270 seconds. No new suite,
model call, provider operation or benchmark verdict change was added. This is
constant filesystem work per lifecycle receipt, with no shared lock or registry
at 10,000 agents. Private evidence is sealed in
`/data/proof87-review-rca/worker-stop-publication.private.tar.gz`, SHA-256
`56a81e55b5c3eab3cd229a1b1567f985354813ab7e4c10ffe7890f1f0cbb9426`.
The source change resets fleet acceptance; these fixtures grant zero fleet credit.


### October 6 recurrence in autoscaler capacity-loop observation

The ordinary deploy structural `benchmark-live-results` gate on committed
`7872fa3d78d7ba38d2556d5b354fe0fc0400ee95` failed the existing actual-autoscaler
control. Seven of eight modes passed; `inventory_dead_publisher` raised
`ValueError: invalid literal for int() with base 10: ''` while the observer
parsed a newly opened PID file. The fixture producer uses shell redirection,
which creates the final path before `printf` completes. The actual invalid
publisher assertion had not yet been reached. The production scaler's recorded
143 was the observer's finally cleanup, not a production verdict. No capacity
mutation occurred, and all recorded native owners were absent after cleanup.

Two archive searches used the exact empty-integer symptom and the broader PID
publication handoff. This case and the October 3 setup-db case describe the same
create-before-payload contract; their earlier producer fixes remain intact.
This is a new fixture recurrence, not evidence that production inventory
ownership validation failed.

The observer now treats an empty publication as pending inside its unchanged
30-second whole-case bound. A complete malformed PID still raises rather than
being accepted. No production function, readiness budget, timeout, or verdict
changed. All 30 assertion ASTs are identical. The same eight actual-autoscaler
modes passed in 11.339 seconds, with every Popen child reaped and every recorded
native owner absent. The existing compact deploy family and benchmark blackbox
already discover this control. Private original and candidate receipts are in
`.context/fresh-basic-claude-final50-20261006/deploy/merged-structural-fixture-repair.private/`;
full final normal qualification remains pending. This supplies no live-task or
fleet acceptance credit.

The user's current guidance treats intermediate observations as pending while
requiring usable stage handoffs, exact resource retirement, and overall bounds.
An observer must not mistake an incomplete fixture publication for a terminal
producer failure.
