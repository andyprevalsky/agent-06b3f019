---
id: 2026-08-03-backend-coverage-hard-coded-port-collides-sibling-workspace
date: 2026-08-03
title: Backend coverage assumed a derived port was private and collided with a sibling workspace
surface: harness
component: backend-coverage-port-reservation
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/run-coverage.sh COV_PORT selection — hard-coded CONDUCTOR_PORT+200 even though Conductor reserves only the workspace's ten-port range
symptoms:
  - "Port 55320 is in use. Free it or set a different CONDUCTOR_PORT."
  - backend-coverage-blackbox exits before collecting coverage while a sibling workspace is healthy
tags:
  - coverage
  - port-reservation
  - conductor
  - deploy-gate
  - related-case
sources:
  - plan:.context/deploy-runs/20260804-010248-92487
  - agent a87224a7-f9ac-4d09-b8c6-b758f37bac38
  - plan:docs/rca/cases/2026-07-19-fleet-hub-port-derived-from-a-colliding-conductor-port.md
repro: back-end/src/tests/unit/coverage-script.test.ts
status: fixed
---

## Problem

The `/deploy` backend coverage gate exited in 0.5 seconds before touching its
coverage directory because port 55320 was already listening. `lsof` proved the
listener was a healthy backend in the sibling Conductor workspace `san-juan`,
not a stale process from this workspace. Dodoma's assigned base port was 55120;
the coverage harness unconditionally added 200 and therefore selected the
sibling's valid primary port.

## Diagnosis

`run-deploy-stage` reported `backend-coverage-blackbox failed` and its stage log
contained the exact port error. `lsof -iTCP:55320` identified process 99344, and
the process command plus working directory placed it in `san-juan/back-end`.
The first owned boundary was `run-coverage.sh`, where `COV_PORT` was computed as
`BASE_PORT + 200` and any listener caused an immediate abort. Conductor's own
workspace allocator reserves ten-port blocks, so arithmetic outside that block
cannot establish ownership. The deepest cause was treating a preferred port as
an exclusive allocation instead of reserving an available port atomically.

Archive searches for `backend coverage port in use CONDUCTOR_PORT`, `coverage
hard-coded port sibling workspace collision`, and `run-coverage COV_PORT`
identified the closest relative in
`2026-07-19-fleet-hub-port-derived-from-a-colliding-conductor-port`: both
harnesses treated arithmetic outside an owned port allocation as ownership.
This is a related case, not a recurrence of the same deepest cause. The earlier
fleet case required duplicate workspace bases plus an unchecked listener
identity and silently reused a foreign hub. Here the workspace bases were
distinct; coverage escaped its allocation with `+200` and correctly failed
closed when that preference landed on a sibling's primary port. The shared
lesson and boundary distinction are cross-linked from the prior case.

## Solution

The coverage launcher now restricts selection to ports `+7` and `+8` inside
Conductor's owned ten-port workspace allocation, claims the selected port with
a process-bound advisory lock, and verifies that no listener already owns it. A
separate process-bound run lock is acquired before any shared coverage artifact
or database can be mutated, preserving fail-before-mutation behavior when two
coverage runs start in one worktree. Backend, blackbox, and unit processes each
run in a registered process group. If the owning shell disappears after child
startup, the lock helper publishes a shutdown marker and takes its final process
group snapshot under the same advisory lock each launcher holds through
`exec`. A launcher already at `exec` is therefore included in the snapshot,
while a delayed launcher observes shutdown and exits before starting its child.
The guardian terminates and waits for the snapshotted groups before releasing
the run lock, so SIGKILL/OOM cannot permit overlapping database or artifact
mutation. Functional tests occupy the preferred port, verify bounded selection
advances, prove a second same-worktree run is rejected, hold a launcher behind
the registry lock while publishing shutdown, then kill an owner after its
descendant starts and prove the descendant is gone before reacquisition.
This changes only local deploy tooling and has no production or 10k-agent
runtime cost.

Post-fix verification: `coverage-script.test.ts` passes its live occupied-port,
concurrent-run, delayed-launch shutdown, executable failure-code,
SIGKILL-recovery, and released-port-reacquisition checks;
`layer-deps.test.ts` passes 1100/1100 structural checks.

## Human feedback

None recorded.

## Reusable lesson

Port arithmetic expresses preference, not ownership; reserve the selected port and verify it is free before mutating shared test state.
