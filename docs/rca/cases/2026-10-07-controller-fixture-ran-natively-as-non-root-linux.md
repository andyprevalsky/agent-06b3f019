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

## Human feedback

None recorded.

## Reusable lesson

Dispatch a fixture by the capabilities it exercises, such as root privileges, not by operating system alone.
