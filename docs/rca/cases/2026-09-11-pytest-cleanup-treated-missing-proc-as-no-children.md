---
id: 2026-09-11-pytest-cleanup-treated-missing-proc-as-no-children
date: 2026-09-11
title: Pytest cleanup treated missing Linux proc files as an empty child tree
surface: harness
component: cloudbench-boot-driver-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: test_real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack converted missing /proc child enumeration into an empty tree before killing the driver
symptoms:
  - detached fixture child survived
  - stale identity killed replacement
  - simulated parallel-tool-calls pytest runners remain parented to PID1 after fixture deletion
tags:
  - pytest
  - macos
  - subprocess
  - fixture-cleanup
  - process-identity
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

A September 11 audit found simulated benchmark PIDs 27632 and 36831 still
alive roughly twenty hours after their pytest runs. Their September 10 birth
times were 14:34:46 and 14:35:50 local time. Both had parent PID1, their own
process groups, no sockets or descendants, and unchanged CPU time during the
audit. Their working directories and log descriptors identified deleted
`test_real_boot_driver_interrup0` fixtures, rather than active benchmarks.

After rechecking each exact birth, parent, group, command, and working directory,
the two processes received TERM and were positively absent. The private receipt
is `.context/acceptance/orphan-pytest-cleanup-20260911.json`. No Hub or provider
resources were changed. Removing those leftovers alone would not fix the test.

## Diagnosis

The path was pytest -> boot supervisor -> guest driver -> detached benchmark ->
fixture `finally` cleanup. The cleanup recursively read
`/proc/<pid>/task/<pid>/children`. On macOS that Linux-only path is absent; the
exception handler converted unavailable enumeration into zero children. Killing
the driver then reparented its uncollected benchmark to PID1. The owning test
never verified descendant termination.

Two permanent subprocess cases exercise normal and assertion-failure cleanup
with real detached descendants and an unrelated process. They force only the
Linux child-list path absent, reproducing macOS on either host. Moving the
original recursion into a callable fixture helper did not repair it: both cases
failed with `detached fixture child survived`. The unchanged assertions passed
after replacing that enumeration and cleanup boundary.

Independent review also found that the first candidate's `ps lstart` identity
had only second precision. A third case changes the captured native birth while
keeping the observed PID and second-level birth unchanged. The first candidate
killed the real target and failed `stale identity killed replacement`; the fixed
helper refuses that stale identity. Test failure cleanup uses the same native
identity guard, so a deliberate red run cannot authorize an unrelated PID.

Archive searches were `/proc pytest orphan cleanup` and
`process identity detached test fixture`. The September 11 port-collision
launcher case and September 9 pending-Hub identity case are relatives, not
recurrences: they establish exact process ownership, but neither fixed this
fixture's missing-proc child discovery. Their solutions and feedback were read.

## Solution

Replace the fixture's driver-PID-file recursion and separate cleanup branches
with one snapshot rooted in the still-owned boot `Popen`. Enumerate ancestry
through portable `ps`, validate it against the snapshot, and capture native
identities through the existing `scripts/process-identity.py`. Stop captured
parents before children and use that helper's adjacent identity-check/kill
operation for every scalar PID signal. Reap the owned root and verify that no
captured birth remains live. This reuses the existing native identity boundary
instead of introducing another process-identity implementation.

The fixture's HTTP client also explicitly bypasses inherited proxies for its
loopback status endpoint. A native verification attempt exposed an inherited
HTTP500 proxy response; bypassing it revealed the actual missing local status
listener. The Linux guest code was not changed to emulate macOS.

The three new cases match the existing Step4cb `boot_payload` selector and the
permanent benchmark blackbox wrapper. Its expected selection count changes from
nine to twelve. Production execution, the 7200-second default, the temporary
300-second task override, and existing cleanup bounds are unchanged.

Private evidence is under `.context/acceptance/orphan-pytest-fixture-fix/`:

- `before.log`: two causal failures; `after.log`: the same two cases pass.
- `stale-identity-before.log`: the first candidate fails the third case.
- `final-native-after.log`: all three final cases pass on macOS in 1.29 seconds.
- `permanent-registration-final.log`: the actual benchmark wrapper passes its
  twelve selected cases. Final review hardened only test fallback cleanup;
  the three affected tests were then rerun successfully on both hosts.
- `proof.json` and `independent-review.json`: final hashes, review and limits.

The exact commands use `agents/venv/bin/python -m pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py`, first with
`-k boot_payload_fixture_cleanup_without_proc_reaps_detached_children`, then
`-k boot_payload_fixture_cleanup_rejects_reused_identity`; final verification
uses `-k boot_payload_fixture_cleanup`.

Linux additionally ran the exact existing
`real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack` test with
those three cases: four passed in 2.51 seconds. OCI exit and the durable command
exit receipt both reported zero in
`.context/acceptance/linux-api-runtime/exec-6950d3e2e9f64682880daa93e1adf250.json`.
The unchanged Linux boot/driver/runner path produced its canonical cleanup ACK.

## Verification limits

This fixes the observed fixture leak; it does not establish a business benchmark
outcome or the separate ten-slice cloud proof. Native macOS lacks the guest's
`setsid` executable and Linux `/proc` ownership interface. The exact guest test
was verified on Linux, not skipped or replaced with a fabricated native ACK.
Both failed native attempts left no processes in their exact fixture trees.

If boot already exited before collection, its `Popen` cannot authorize discovery
of reparented descendants. The helper does not claim to repair that separate
window or infer ownership from an orphan scan. The existing native check-and-kill
helper narrows, rather than atomically eliminates, the POSIX PID-reuse window.

## Human feedback

The standing request was to finish the work with bounded runs. This investigation
was constrained to exact owned cleanup, an underlying fixture repair, and
recurring regression coverage. Hub retirement, provider actions, relaxed bounds,
and changes to production guest behavior were outside its scope.

## Reusable lesson

Treat unavailable child discovery as a failed ownership observation, and terminate only descendants captured from a live owned root with native process identities.
