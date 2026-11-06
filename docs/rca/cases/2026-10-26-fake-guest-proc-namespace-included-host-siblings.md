---
id: 2026-10-26-fake-guest-proc-namespace-included-host-siblings
date: 2026-10-26
title: Fake guest process enumeration admitted host siblings and omitted guest children
surface: harness
component: run-deploy-structural-gates LinuxGateStorageRetentionTests fake Fly adapter
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The fake flyctl bounded_proc adapter selected its host parent and same-parent siblings rather than the fake guest process and descendants
symptoms:
  - cannot observe controller writer ownership
  - PermissionError reading /proc/4076364/task/4076364/fd
  - test_fixture_failure_retention_reaches_native_env_and_refuses_invalid_values failed for keep=0
  - an unreadable guest child was omitted and export incorrectly succeeded
tags:
  - structural-tests
  - fixture-isolation
  - proc
  - permission
  - writer-ownership
  - forensic-export
sources:
  - commit b3679ea7be34ce096cc3686b6cb3d03eb746f299
  - task required deploy structural gate RCA on 2026-10-26
repro: scripts/tests/run-deploy-structural-gates.test.py::LinuxGateStorageRetentionTests.test_fake_export_ignores_foreign_unreadable_host_sibling
status: fixed
---

## Problem

The required structural gate failed at
`LinuxGateStorageRetentionTests.test_fixture_failure_retention_reaches_native_env_and_refuses_invalid_values`
for `keep='0'`. The fake Fly transport invoked the real generated controller
export helper, which raised `cannot observe controller writer ownership` after
`PermissionError` reading `/proc/4076364/task/4076364/fd`.
The evidence is `.context/rca-6731984c/deploy-structural-v2.log:2393-2445`.
The original PID had exited before this investigation; its executable and
reason for denying access were not retained. No claim is made that it used the
same dumpability setting as the controlled reproduction below.

The unchanged original test passed in isolation in 1.901 seconds. That did not
close the incident: it showed the missing environmental condition needed a
controlled reproduction. All operations in this investigation were local;
no Fly/provider operations, deployment or production code changes were made.

## Diagnosis

Critical path: native unittest -> fake Fly machine launch -> execute real
uploaded controller export helper -> bounded fake `/proc` view -> real writer
ownership scan -> export/retention outcome.

The test's `bounded_proc` selected same-UID processes whose PID was the fake
transport or its parent, or whose parent matched the fake transport's parent.
Consequently unrelated host siblings entered the emulated guest, while actual
children of the fake transport did not. UID equality does not establish either
namespace membership or readability of another process's cwd/fds. A native
same-UID child with `prctl(PR_SET_DUMPABLE, 0)` still has a same-UID `/proc/PID`
directory, but its protected task paths raise PermissionError.

Two new native controls demonstrate both directions at the same real helper
boundary, without replacing `writers`, `export`, authority checks or archives:

1. A wrapper starts a nondumpable sibling outside the fake guest and launches
   the fake guest next to it. The old test adapter exposes that host sibling;
   real export fails with PermissionError and no verified export.
2. The fake guest starts its own nondumpable child. The old adapter hides that
   real guest child; export incorrectly succeeds instead of refusing an
   unobservable member of its namespace.

Exact unchanged command, from the repo root with the agents venv activated:

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/tests/run-deploy-structural-gates.test.py LinuxGateStorageRetentionTests.test_fake_export_ignores_foreign_unreadable_host_sibling LinuxGateStorageRetentionTests.test_fake_export_refuses_unreadable_owned_guest_child
```

Before: both failed in 1.791s. The first returned 1 with the production helper's
`cannot observe controller writer ownership`; the second returned 0 with
`GATE_EXPORT_VERIFIED` when refusal was required. After: the identical two
controls passed in 1.520s. Evidence is
`.context/rca-structural-observer/before.log` and `after.log`.

The deepest owned cause is an incorrectly modeled guest process namespace in
a local transport fixture. The production collector correctly fails closed
when an included process cannot be observed. Changing it to ignore permission
errors, trusting UID alone or removing retention checks would repair the wrong
layer. The fixture was already modeling a remote guest locally; its membership
must describe that guest, not arbitrary host processes.

Archive searches used `cannot observe controller writer ownership` and
`foreign process fixture permission proc` after reading the runtime failure.
The September 11 missing-proc cleanup and foreign-client socket cases were read,
including their solutions and feedback. They are relatives (incorrect local
observation boundaries), not prior fixes of this fake Fly namespace defect.

## Solution

In `scripts/tests/run-deploy-structural-gates.test.py`, change only the fake
Fly adapter's `/proc` enumeration: start at the fake guest's own PID and visit
its native descendants through every task's `children` file. The host caller
and its siblings are outside this synthetic namespace. Record a selected PID
before reading its tasks so a disappearing thread cannot suppress observation
of an otherwise live process by the real collector. Permission errors are not
caught or converted to absence. Real cwd/fd/maps/birth observations and the
production export code are unchanged.

Keep both polar native controls in the existing unittest class. Each observer
is an owned subprocess that announces readiness, blocks on its stdin, and is
joined after that pipe is closed. The foreign control requires verified real
export and exactly three archive retrieval calls, with no machine destruction.
The owned-child control requires the original ownership error, no verified
export, no archive retrieval, and no machine destruction. The original keep
0/1 forwarding and invalid-value assertions are unchanged.

The two controls passed five consecutive times on the final test code. The
original retention test and both controls also passed together in 3.472s.
The entire owning file passed 52 tests in 89.202s before a final traversal
hardening; the final source-bound full-file run passed all 52 tests in 88.284s,
recorded in `.context/rca-structural-observer/final-full.log`.
No timeouts, writer-drain budgets, retention rules or production acceptance
criteria were changed. No permanent regression runner was added: the file is
already registered at `scripts/run-deploy-structural-gates.py:251` and in
`/deploy` Step 4s.

Golden references opened:

- `openclaw/src/process/kill-tree.test.ts:73-100` defines a finite synthetic
  process tree, distinguishes a foreign PID, and fails on unexpected proc paths.
  The fixture correction converges on explicit process namespace membership.
- `hermes-agent/tests/agent/test_owned_process_cleanup.py:26-44` keeps parent,
  child and sibling owners distinct despite a shared terminal environment.
  The correction likewise stops using shared host ancestry/UID as guest scope.
- `codex/codex-rs/cli/tests/exec_server/pid_namespace_tests.rs:15-45` deliberately
  controls PID namespace behavior and simulates an unavailable proc mount;
  namespace selection is test setup rather than permission-check suppression.
  Rose uses its existing local fake transport rather than requiring a new
  privileged kernel namespace.
- Claude Code was searched for process/proc namespace fixture analogs; no
  comparable forensic export or fake PID namespace implementation was found.

This is test-only; production trajectory behavior is unchanged. At scale the
fixture visits only its owned guest process tree instead of host-wide process
lists. It does not introduce runtime polling, shared state or provider work.

## Human feedback

The coordinating agent assigned only the structural test file and a separate justified case,
prohibited weakening permission/ownership/retention/forensic guards, and required
native before/after proof and polar controls. Production helpers and deployment
remain parent-owned. The original planner V2 review remains valid for its exact
unchanged runtime bytes. Do not reindex the shared RCA INDEX from this worker;
the parent validates the combined archive. Independent parent review remains
part of the handoff; no child reviewer was launched under the bounded assignment.

## Reusable lesson

Model a fake guest's process namespace from its owned guest root and retain real permission failures for every included descendant.
