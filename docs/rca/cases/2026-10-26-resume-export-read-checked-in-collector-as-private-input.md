---
id: 2026-10-26-resume-export-read-checked-in-collector-as-private-input
date: 2026-10-26
title: Resume export read the checked-in collector source through the owner-only private-input reader, and its test was not a deploy gate
surface: infra
component: cloudbench-resume-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/cloudbench-resume-controller-export.py verify_stage read value['collector_path'] (scripts/cloudbench-controller-export.py in the source checkout) with the original600 runner's read(), which requires mode & 0o077 == 0 and nlink == 1; a normal umask-022 checkout holds it at 0644"
symptoms:
  - "ValueError: private current-owner file required (verify_stage, 4 tests in cloudbench-resume-controller-export.test.py)"
  - "AttributeError: module 'signal' does not have the attribute 'pidfd_send_signal' under agents/venv Python 3.11.9"
  - test_stream_get no-local-staging assertion compared the shared tempfile.gettempdir() listing before and after
tags:
  - cloudbench
  - controller-export
  - deploy-gates
  - file-permissions
  - test-hermeticity
sources:
  - PR #1582
  - commit 7c173ec12
  - memory:agents-venv-lacks-pidfd
repro: scripts/tests/cloudbench-resume-controller-export.test.py (registered in scripts/run-deploy-structural-gates.py and deploy.md Step 4s)
status: fixed
---

## Problem

`scripts/tests/cloudbench-resume-controller-export.test.py`, landed with PR #1582
(merge 7c173ec12), failed on main with four `ValueError: private current-owner
file required` errors from `verify_stage`. The test was not in the deploy
structural registry, so nothing caught it. Under the agents venv one more case
failed because that interpreter has no `signal.pidfd_send_signal`. A no-staging
assertion also compared the shared temp directory before and after the call.

## Diagnosis

`verify_stage` reads the original collector,
`<source_root>/scripts/cloudbench-controller-export.py`, with the original600
runner's `read()`. That reader is for private receipts: it requires an
owner-only mode and a single link. The collector is a checked-in source file
(git mode 100644), so any checkout made under umask 022 holds it at 0644. That
includes the canonical `/home/boxes/rose` checkout and Andy's Mac. The test
fixture pointed at the repository's own collector, so the result depended on
the checkout's umask. A worktree created under umask 077 has a 0600 collector
and passes. Changing that same file to 0644 reproduces all four errors. The
real resume path would refuse every normal checkout in the same way.

The pidfd failure is in the test only. `readonly_hubs` executes the
collector's `retire_disposable_hubs` without its signalling tail. The test
patches `signal.pidfd_send_signal` to prove it is never called, but
`mock.patch.object` cannot patch an attribute the interpreter lacks. The uv
CPython 3.11.9 build also lacks `os.pidfd_open`.

## Solution

- Product: add `read_source()` to the resume export. It requires a physical
  path without a symlink, a regular file owned by the current user, no
  world-write permission and a 16 MiB size bound. `verify_stage` uses it for
  the collector on both reads. The bytes are still bound by the launch
  record's `collector_sha256`, the git-show equality check and the re-read
  equality check.
- Test: the fixture copies the collector to a private 0644 file. A new case
  accepts that checkout mode and refuses a world-writable (0666) or symlinked
  collector. The pidfd case patches with `create=True`; when `os.pidfd_open`
  is missing, it uses an owned `/proc/<pid>` directory fd that must still be
  closed exactly once. The stream test uses a private temp root.
- Registered `cloudbench-resume-controller-export` in
  `scripts/run-deploy-structural-gates.py` and deploy.md Step 4s.

Before the fix, the test had four errors under the canonical 0644 mode and
five with the new case. After the fix, all 30 tests passed five consecutive
times with `/usr/bin/python3` 3.12 and five with agents/venv 3.11.9, each
using a private TMPDIR.

## Human feedback

None.

## Reusable lesson

A private-receipt reader that enforces owner-only mode must not read
checked-in source, whose mode depends on the umask that created the checkout.
Bind source by its content hash and physical path. A test that reads repository
files as fixtures must pin the mode it expects instead of inheriting the
checkout's mode. A new `scripts/tests/*.test.*` file is not coverage until it
is listed in the deploy registry.
