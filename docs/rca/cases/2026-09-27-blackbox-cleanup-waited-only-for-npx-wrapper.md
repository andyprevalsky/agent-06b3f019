---
id: 2026-09-27-blackbox-cleanup-waited-only-for-npx-wrapper
date: 2026-09-27
title: Blackbox runner waited for its npm wrapper while backend descendants survived
surface: harness
component: backend-blackbox-process-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-blackbox-tests.sh cleanup killed and waited only for its background npx PID
symptoms:
  - Blackbox native exit zero while tsx and backend processes remain live
  - Isolated backend listener survives the test launcher
  - Owned backend descendants are reparented to PID 1 after cleanup
tags:
  - blackbox
  - subprocess
  - cleanup
  - npx
sources:
  - PR #1299
  - commit f94858c8316609b2c8e7c94c07f2b74a7672687f
repro: scripts/tests/blackbox-process-cleanup.test.py
status: open
---

## Problem

The unchanged Codex domain passed all 24 tests and its retained launcher exited
zero, but fresh native process inspection found backend descendants 20645 and
20656 still executing in the test's original process group. Both carried the
exact unique artifact-directory environment; the backend still listened on
port 3102. The independent IndexedDB replay showed the same class with three
surviving descendants, and the subsequent 15-domain replay reproduced it.
Wrapper completion was not descendant retirement.

## Diagnosis

`run-blackbox-tests.sh` launched `npx tsx src/bootstrap.ts &`, recorded `$!`,
then signaled and waited only for that npm wrapper. Killing the launcher
reparented its server descendants. No descendant snapshot or terminal check
preceded release of the port claim. Exact captured native identities were
used to retire the observed orphans; fresh checks proved their absence and
closed listeners before the database lane was reused.

Archive searches `npx tsx backend cleanup orphan` and `test runner exits
children survive process group` found the September 11 port-fixture launcher
case and September 27 zombie-state assertion case. These are relatives:
the former fixed fixture exec identity, while this launcher owns a real
multi-process service. Replacing npm with a different executable would not
establish descendant ownership. The existing canonical tree-drain helper is
the single reusable implementation for that responsibility.

An offline reproduction extracts the actual launch/trap block. Its transport
fixture creates a wrapper waiting for a real TERM-resistant server; the
wrapper exits on cleanup TERM before the server does. A same-command
neighbor remains alive. The original block fails all four controls: normal
exit, failed test exit, cancellation, and unknown process-table state.
The same controls pass after the candidate change, with unchanged native
exit assertions, no late server writes, and the neighbor intact.

## Solution

The repaired launcher reuses
`cloudbench_terminate_tree_and_wait` before joining the background wrapper.
It installs cleanup before admission and defers cancellation only over the
child-to-PID ownership handoff. Successful cleanup preserves the original
test exit; unverified cleanup fails and retains the port claim without an
unbounded wait. No provider calls or application/benchmark behavior change.

The permanent Python controls are called from the already-discovered
`coverage-script.part2.test.ts` unit entrypoint. The exact candidate entrypoint
passed on Mac; the four controls also run on the owned Linux host against
privately staged candidate bytes while its checkout remains unchanged.
Evidence and hashes are in
`.context/acceptance/proof21-blackbox-cleanup-rca/`.

The proven helper contract captures descendants while the launcher remains an
owned live job. The fixture does not claim that a launcher which independently
exited before cleanup would leave a discoverable tree. This is the observed
npm-cleanup boundary, not a new universal process supervisor.

Independent final review passed and the exact reviewed implementation and
controls are promoted. Full canonical gates remain pending. The original live domain passes are retained, but they are not
retroactively relabeled as having performed correct automatic cleanup.

## Human feedback

The user required infrastructure-only changes and exact owned-resource
cleanup without changing benchmark behavior or acceptance thresholds.

## Reusable lesson

Retire and verify the owned service descendants before treating a launcher PID exit as completed cleanup.
