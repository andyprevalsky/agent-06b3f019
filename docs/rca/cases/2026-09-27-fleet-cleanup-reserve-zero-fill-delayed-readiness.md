---
id: 2026-09-27-fleet-cleanup-reserve-zero-fill-delayed-readiness
date: 2026-09-27
title: Fleet cleanup reserve zero-fill stalled controller readiness on Linux storage
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: reserve_cleanup_disk_space synchronously wrote and flushed 512 MiB of zeroes when the Linux filesystem supported physical preallocation
symptoms:
  - detached cancellation fixture never published its exact recoverable guest identity
  - reserve dd remained in kernel D state inside fsync after all 512 MiB were written
  - exact clone identity and status proxy appeared after the unchanged readiness window
tags:
  - cloudbench
  - disk-reserve
  - fsync
  - linux
  - readiness
sources:
  - PR #1299
  - commit 9f3266b699347c42d614eadff6451b773e9cce29
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown
status: fixed
---

## Problem

The full Linux multi-workstream controller fixture failed its exact recovery
readiness check after earlier scenarios passed. Its ordinary failure cleanup
removed the original detached log, so that occurrence alone did not prove which
readiness fact was late. Focused unchanged replays retained the fixture and
reproduced the failure with temporary files on the data volume, including the
compliant outside-checkout path `/data/controller-tmp`.

No benchmark fleet ran. This was the real controller with the existing fake
provider, its unchanged 400-by-0.05-second readiness loop, and the normal 512 MiB
cleanup reserve. Raw evidence is private under
`.context/acceptance/proof21-exact-recovery-order-rca/`.

## Diagnosis

Archive searches used the exact readiness error and
`cleanup reserve dd fsync startup delay readiness`. The
[temp-filesystem case](2026-09-27-cloud-controller-temp-root-ignored-persistent-volume.md)
concerned insufficient free space; this incident had adequate data-volume
space. The [retained-fleet case](2026-09-11-failed-stability-proof-abandoned-retained-fleet.md)
explains why recoverable ownership precedes reserve allocation, but did not
address the reserve's writeback cost. These are relatives, not proof of this
failure's cause.

The path was detached owner publication -> registry initialization -> physical
cleanup reserve -> visibility/provider startup -> guest identity/status port.
The third focused replay bound native controller identity, current working
directory and immutable script-snapshot bytes before observing descendants.
It captured 59 samples of the same `dd` process spanning 15.376 seconds. After
writing 536,870,912 bytes, `dd` remained in kernel `D` state inside syscall 74
(`fsync`), with `rq_qos_wait` and `folio_wait_bit_common` wait channels. The
required `.cid` and status port appeared 3.589 and 5.137 seconds after the test
failed. A separate invocation of the exact reserve function took 15.209 seconds
and verified its full physical allocation.

The earlier observers did not follow the detached snapshot command correctly;
those excluded observations remain preserved and are not syscall evidence.
After capture, exact owned fake-fixture groups were retired using their pinned
native owner identities. No real fleet resources were allocated or modified.

The first incorrect implementation choice was using zero-fill writeback as the
only way to reserve disk capacity on a filesystem with native allocation. The
reserve itself, its size, controller headroom, identity guards and readiness
bound were required and were preserved.

## Solution

The existing reserve function now uses Linux `os.posix_fallocate`, then `fsync`
and exact regular-file size/allocated-block checks. The reserve remains fully
allocated; sparse truncation is rejected. Missing platform capability or
`ENOSYS`/`EOPNOTSUPP`/`ENOTSUP` uses the previous `dd ... conv=fsync` path.
Allocation errors such as `ENOSPC`/`EIO`, synchronization failure, short size or
insufficient blocks fail closed and remove only the exact reserve. Existing
pre- and post-allocation headroom checks and release ordering are unchanged.

This runs once per controller, adds no service or shared coordination, and
keeps the same disk reservation at 10,000 agents. Prompts, models, evaluators,
benchmark timeouts, test deadlines and acceptance criteria are unchanged.

## Verification

The existing canonical reserve regression retains its real allocation/release,
constrained-space, insufficient-space, post-allocation race and ordering
checks. Ten added controls cover successful preallocation, unsupported/missing
capability, non-Linux fallback, allocation and synchronization errors, sparse
and short files, failed fallback and preservation of an unrelated neighbor.
The same test failed before the runtime change and passed afterward on macOS;
its staged exact-source Linux execution passed in 2.61 seconds.

The remote checkout remained clean at `9f3266b6`. The fixed executions used a
private staged source with fleet SHA256 `0e8db482275eaa27ddd29b115068e7de94a25fadc939b955cb5d3a56e0b50803`
and test-module SHA256 `266c99dd93b154ca96fd5d09963db4c7ffdc3c7633d18851aef7188f393afa26`;
they are not executions of a future committed HEAD. Exact command payloads are
`worker3.py` and `after-worker.py`, with the same
`CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY=1` and
`CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=1` selector, distinct owned temporary
paths, and the source root selecting baseline or candidate bytes.
`native-owning-after.json` records the actual Linux pytest command and hashes.
The successful candidate also retained the complete 536,870,912-byte,
1,048,584-block reserve in its observed native timeline.

The unchanged focused selector changed from native exit 1 to native exit 0 and
verified acknowledged exact recovery with the intentional missing-evidence
retention contract. The fixture file remained SHA256 `932c3b3a4a8239637a73beefdc9deb49451450214208cd20b240fe62ee4fa21f`.
The complete unchanged multi-workstream fixture subsequently passed this exact
cancellation case and scenarios through 2d. It exited 1 after 482.03 seconds at
scenario 2e: uploads reported success, but the worker wrapper was missing at
the expected fake-machine path before the intended readiness check. That
separate fixture investigation remains pending. That
separate failure is not a suite pass or a reserve regression. The native result
and complete output remain in `full-after.json` and `full-after.private.log`
(log SHA256 `d2ddf308ffe32888c06ee8b9a9588e8243cd3542b9b393d64d08c4fa909a1d81`).
Independent source and narrative reviews found no reserve-fix blockers. The
reserve boundary is repaired; the full controller gate remains blocked by the
separate fixture issue. This local repair provides no credit toward the required
ten consecutive live slices.

## October 6, 2026 recurrence on macOS

The fifty-copy cached startup diagnostic exposed a separate concurrent disk
admission defect, recorded in
[its own case](2026-10-06-cleanup-reserve-admission-used-concurrent-free-space-snapshots.md).
During that investigation, the reserve still used zero-fill on macOS although
the native filesystem supports physical preallocation. The unchanged owning
Darwin control failed on the original source because `dd` was invoked, then
passed with verified `F_PREALLOCATE` allocation. A real 32 MiB reserve retained
its exact inode, mode, size, allocated blocks and zero-readable contents;
release preserved an unrelated neighboring file. The component allocation
measurements were 0.087 seconds for zero-fill and 0.048 seconds for native
allocation. These measurements do not establish a fifty-copy startup speedup.

The implementation uses the Darwin SDK's native `fstore_t` layout and verifies
physical allocation before accepting the file. Only capability errors from the
allocation operation use the original fallback. Allocation, truncation,
synchronization, inode and sparse-file failures remain fatal. The existing
Linux path is preserved. The compact deploy gate selects the owning allocation,
fallback and release controls; Darwin execution adds three capability and nine
fatal-boundary inverses. Root review required restoring the capability fallback
after the first draft treated unsupported native allocation as a fatal error.
Private scalar receipts and raw logs are retained under
`.context/native-darwin-cleanup-reserve-20261006/`; independent review of the
combined admission boundary is under
`.context/fleet-preflight-local-rca-20261006/`. No task or provider calls were
used for these local controls.

## Human feedback

The user required infrastructure-only work, trustworthy terminal execution and
teardown, and unchanged benchmark behavior with a five-minute per-run limit.
No reserve reduction, longer readiness wait or relaxed outcome criteria was
used to make this fixture pass.

## Reusable lesson

Reserve disk capacity with verified physical allocation instead of unnecessary zero-fill writeback when the filesystem supports it.
