---
id: 2026-10-07-controller-fixture-ran-natively-as-non-root-linux
date: 2026-10-07
title: Status-service controller fixture ran natively on a non-root Linux host that cannot exercise its root-only checks
surface: harness
component: run-cloudbench-controller-linux
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/run-cloudbench-controller-linux.py main selected the native path for every sys.platform == "linux"
symptoms:
  - "AssertionError: requires Linux Python3.11.9"
  - "controller Linux runner failed: CalledProcessError"
  - "NameError: name 'pytest' is not defined"
tags:
  - linux
  - cloud-vm
  - root-namespace
  - controller-image
  - deploy-step-4cb
sources:
  - PR #1417
repro: scripts/tests/cloudbench-controller-linux.test.py
status: fixed
---

## Problem

Step 4cb's `python3 scripts/tests/run-cloudbench-controller-linux.py --fixture
status-service-shutdown` failed immediately on the Cursor Cloud Linux VM. Its
preflight rejected the host's Python 3.11.15 and Node 22.22.2 with "requires
Linux Python3.11.9". With exact Python 3.11.9 and Node 22.13.0 installed and
selected, the fixture then failed with `NameError: name 'pytest' is not defined`.

## Diagnosis

The dispatcher ran the fixture natively whenever `sys.platform` was Linux and
used the offline pinned container only on other hosts. The fixture is written
for a root Linux namespace. It extracts
`test_prebuilt_checkout_browser_cache_parent_is_runtime_writable` without
pytest, and that test calls `pytest.skip` unless the effective UID is 0. On
this VM the agent runs as UID 1000, so a native run could never execute the
root-only permission primitive. The Fly controller runs as root with its own
toolchain, and the Mac path's container runs as root with the pinned versions,
so both paths were valid. Only non-root Linux hosts were dispatched to an
environment the fixture cannot use.

## Solution

The native path now requires Linux and effective UID 0. Every other host,
including non-root Linux, runs the same offline exact-owner container as the
Mac path, with the pinned Python and Node, no network, and verified
container retirement. The dispatcher tests cover non-root Linux reaching the
container and root Linux running the exact native preflight. Against the old
dispatcher, the non-root case fails with "ran the fixture natively". The
fixture's assertions are unchanged.

### Reconciled with main's parallel fix

`main` fixed the same `NameError` separately in `94a32110c`. It imported
`pytest` into the extracted cache-parent control and printed `SKIP` when the
control called `pytest.skip`. After merging `main`, the 4cb gate failed in the
container with `ModuleNotFoundError: No module named 'pytest'`, because the
offline controller image deliberately has no pytest. A native non-root run
also skipped all three permission states and still printed `PASS`. The merge
keeps the container dispatch. The extraction now runs without pytest and
exits with `FAIL` unless it runs as root on Linux. Through the runner, all three
states execute in the container. A direct non-root run now fails and names the
runner.

A later `main` change (`8fb281874`, `8fabcdd4f`) routed unpinned Linux hosts to
the container and skipped the control when pytest was missing. The second
merge combines both conditions. A host runs the fixture natively only when it
is root Linux and passes the pinned-toolchain preflight. Every other host uses
the container, and the control still runs there without pytest instead of
skipping. The dispatcher tests cover four cases: root and pinned (native),
root and unpinned (container), non-root and pinned (container), and a direct
non-root extraction (`FAIL`).

## Human feedback

None recorded.

## Reusable lesson

Dispatch a fixture by the capabilities it exercises, such as root privileges, not by operating system alone.

### 2026-10-15 deploy environment recurrence

The default container build failed before fixture execution when Docker Hub
returned HTTP 502 for the pinned Node22.13.0 base manifest. Docker's public status
page reported operational; no provider-wide incident attribution was established.
No verified controller image was cached on this devbox.

The supported root/native route passed its version preflight with an isolated,
checksum-verified Node22.13.0 distribution and Python3.11.9. Its unchanged
cache-parent control then failed because the fixture's reduced-privilege child
could not execute Python beneath the private `/home/boxes` parent. Copying the
runtime alone retained uv's 0700 directory permissions and failed the same
assertion again. After granting read/traverse permission only on the newly
created standard-library runtime copy under `/tmp/rose-controller-native.*`, the
same unmodified status-service fixture passed all native ownership, three cache
permission states, atomic generation, and authenticated shutdown controls.
Original home permissions, source assertions, and application code were unchanged.

Retain `.context/deploy-cloud-controller-r8.log`,
`.context/deploy-controller-native-r8.log`,
`.context/deploy-controller-native-r8b.log`, and the passing
`.context/deploy-controller-native-r8c.log`. Native tool admission establishes
versions and root privileges; a private interpreter path can still be unusable
by a fixture child. Use a traversable isolated runtime when selecting this native
route, or use the recipe-verified offline container. This local fixture setup has
no agent/runtime cost at 10,000 agents.
