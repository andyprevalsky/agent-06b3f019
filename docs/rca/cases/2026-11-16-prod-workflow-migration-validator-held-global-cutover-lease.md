---
id: 2026-11-16-prod-workflow-migration-validator-held-global-cutover-lease
date: 2026-11-16
title: Production workflow-migration validator held the global cutover lease for its whole run, serializing every owner's deploy lane and real cutovers
surface: back-end
component: validate-prod-workflow-migration
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/scripts/validate-prod-workflow-migration.ts main() — acquireProductionDeploymentLease() took ToolSideEffect 'deployment:temporal-workflow-cutover' (polling up to DEPLOYMENT_LEASE_WAIT_MS = 600 s) and held it, renewed every 20 s, until the run's finally block
symptoms:
  - Timed out after 600000ms waiting for the production cutover lease
  - Another Temporal workflow deployment currently owns the production cutover
  - validate-prod-workflow-migration exited 1
  - workflow-migration lane FAIL harness_execution
tags:
  - deploy
  - workflow-migration
  - temporal
  - lease
  - serialization
  - batched-merge
sources:
  - PR #2086
  - commit fdfed5132e
  - PR #2265
  - PR #2318
  - commit cc4e5ba05d
status: fixed
repro: back-end/src/tests/unit/workflow-migration-validation-run.test.ts
---

## Problem

In the 2026-11-15/16 batched merge wave (#1946, #2086, #2104, #2134 after #2127),
every owner ran `scripts/deploy production --lanes workflow-migration`, which
runs `npx tsx scripts/validate-prod-workflow-migration.ts --execute`. #2086's lane
failed three times with `Timed out after 600000ms waiting for the production
cutover lease`. It passed only on the 4th attempt, 21 hours later, and #2265's
deploy recorded the same contention. #2318's read-only prod diagnosis showed
back-to-back validator runs each holding `deployment:temporal-workflow-cutover`
for about 6 min (02:42, 02:48, 02:54, 04:26, 04:33, 04:39, 04:45Z on 11-16).
`deploy-agents.yml` cooperative cutovers also held it for up to 28 min, which is
longer than the lane's whole wait.

## Diagnosis

1. `main()` called `acquireProductionDeploymentLease()` before creating any
   fixture. That function retried `acquireWorkflowDeploymentLease()` (the
   single global row, which real Fly cutovers and the worker-deployment queue
   also own) every 2 s for up to 600 s. It held the lease for the whole run and
   released it in `finally`.
2. So N concurrent owners' validation lanes ran one at a time, and any real
   cutover held during that window starved them. Conversely, a running validator
   blocked real cutovers from acquiring the lease. Local repro: two concurrent
   `beginValidationRun` calls (the extracted pre-fix admission code); the second
   was not admitted within 5 s (`second concurrent validation was not admitted
   within 5000ms`).
3. Why it was possible: the lease was added with the original cutover hardening
   (commit cc4e5ba05d) as a blanket guard. Almost every check is already
   isolated per run (run-unique user, dormant task queue, agent and workflow
   IDs). The validator has two surfaces that are really shared:
   - `same_sha_old_marker_is_retired...` called the fleet-wide
     `cleanupSupersededWorkerActivationMarkers`. That terminates every running
     `navi-worker-deployment-activation:*` marker except its own, including a
     concurrent deploy's freshly activated marker (workers gate production
     polling on it) and other validator runs' markers.
   - `production_fleet_has_no_stuck_cutover_state` excluded only its own user,
     so another live run's fixtures could look "stuck".

   The blanket global lease hid those two shared surfaces instead of isolating
   them.

## Solution

`back-end/scripts/workflow-migration-validation-run.ts`, used by the validator:

- Admission takes a liveness lease keyed by the run's own ID
  (`deployment:workflow-migration-validation:<runId>`). No other run or cutover
  contends for it, and the validator never reads or writes the cutover lease.
- Marker retirement still runs the production
  `cleanupSupersededWorkerActivationMarkersWithClient`. It goes through a
  `WorkflowClient` subclass whose visibility `_list` yields only this attempt's
  two markers and whose identity is the run's user ID.
- The check asserts the old marker was terminated by this run's identity and
  the current one stays RUNNING. When Temporal's terminated event records a
  foreign identity (a real cutover's fleet-wide cleanup finishing
  concurrently), it mints a fresh pair, at most 3 attempts.
- The stuck-state check excludes another validation run's fixtures only while
  that run's liveness lease is current. Fixtures left by a crashed or ended run
  still fail the check.
- Real cooperative cutovers can now overlap a validation run. When one hands a
  parked candidate off (continue-as-new onto the new queue) during a
  cold-history window, the window is re-observed on the new generation, at most
  3 times. A failure within one generation is rethrown unchanged.
  Independent review (/RCA step 7) found this hazard, which the lease used to
  mask.

Regression: `back-end/src/tests/unit/workflow-migration-validation-run.test.ts`
(backend-unit lane) covers:
- concurrent admission;
- live/ended/crashed run exclusion;
- scoped retirement leaving a deploy marker and another run's marker untouched;
- terminator attribution;
- generation-scoped cold observation.

The structural test `scripts/tests/workflow-deployment-migration.test.sh`
forbids the validator from using the cutover lease or the fleet-wide cleanup.
At 10k agents: admission is one insert per run, and the stuck-state check adds
one indexed `operationKey IN (...)` read bounded by the number of concurrent
validator runs. Nothing is per-agent.

## Human feedback

The goal set by the user: "deploys must never serialize on each other". The validation must not take, or block on,
the production cutover lease for its whole run, while keeping no interference
with a real cutover, per-run fixture isolation and every existing check row.

## Reusable lesson

Never guard a verification run with the production deploy lease; isolate each
shared surface it touches (scope fleet-wide cleanups to the run, attribute
mutations by identity, exclude only provably live peers) so concurrent deploys
verify in parallel.
