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

### 2026-10-16 recurrence: reduced-user runtime and ambient fixture permissions

The WHM deploy C6 controller status-service fixture failed the cache traversal
assertion on `1a573eb69c6b0950f579b752deb1794058dff5e9`. The unchanged 571-byte
log SHA256 is
`42f2eecdb976ee0557a6a15fc11b2b688545ce2758ceaed9d9f776d1a93d4bd0`.
The exact test body matches upstream main, C5, and C6; the production driver
also matches main. The previous C5 pass does not qualify current prerequisites.

The sole observer captured the actual selected Python's literal and resolved
ancestors. The version root and bin directories were 0700, owned by the app
user, so the fixture's daemon child could not traverse them. The root version
preflight was therefore insufficient. This repeats the private-interpreter
prerequisite above; it does not establish a production shared-cache defect.
Original child stderr was not captured, and the later permission census does
not claim a historical kernel-error trace.

A second fixture dependency was reproduced independently. Its new root-owned
data directory was requested with mkdir(0755), but umask 077 made it 0700. The
fixture already explicitly required that ancestor to be 0755 in its final
assertion. With an isolated byte-exact public Python 3.11.9 copy, all three
cache states pass under 022, fail under 077, and pass under 077 after setting
only the newly created data directory to its intended 0755. The seven original
assertions are unchanged. Terminal controls observed exit 1 in 0.475 s before
and exit 0 in 0.530 s afterward, using the real reduced-UID boundary. A private
interpreter with otherwise traversable fixtures still failed under 022, proving
that the one-line fixture correction alone cannot qualify the actual VM.

The original launcher explicitly sets umask 077, but nested sudo policy was not
captured at the event. The controlled umask dependence is not claimed as the
sole historical C6 cause. The runtime prerequisite is repaired only through a
new owned copy of the existing exact pinned nonsecret CPython distribution,
with every original member hash and symlink checked, explicit permissions on
the new copy only, and an actual daemon execute/stdlib-import preflight. Old
runtime assets, home permissions, secrets, protected instructions, native
Python 3.12, browser caches and production driver policy remain untouched.

The source correction is one explicit chmod on the fixture's new data parent.
The public runtime copy and next-gate prefix are a separate environment
prerequisite, with actual execution and normal controller qualification
required before any deploy credit. The original C6 failure is retained; local
controls do not substitute for the next full normal VM gate. At 10,000
production agents the test-only line adds no runtime work.
