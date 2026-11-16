---
id: 2026-11-16-cutover-lease-rotating-holders-anonymous-row
date: 2026-11-16
title: Prod workflow-migration lane timed out on a cutover lease held by rotating legitimate owners whose row recorded no identity
surface: back-end
component: workflow-deployment-lease
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/workflowDeploymentLease.ts acquireWorkflowDeploymentLease — the lease row stored only a random owner UUID and {leaseMs, renewedAt}, so the busy error and the validator's 10-minute timeout could not name who held the lease
symptoms:
  - Timed out after 600000ms waiting for the production cutover lease
  - Another Temporal workflow deployment currently owns the production cutover
  - deployment:temporal-workflow-cutover
tags:
  - deploy
  - workflow-migration
  - lease
  - observability
sources:
  - PR #2184
  - PR #2245
  - memory:pr2184-wmh-lane-planner-effort-deploy
repro: back-end/src/tests/unit/workflow-deployment-lease.test.ts
status: fixed
---

## Problem

The production deploy `workflow-migration` lane (`scripts/deploy_prod.py` running
`back-end/scripts/validate-prod-workflow-migration.ts`) failed with
`Timed out after 600000ms waiting for the production cutover lease` for #2184 and
#2245. The `ToolSideEffect` row `deployment:temporal-workflow-cutover` held only
`externalId=<random UUID>` and `request={leaseMs, renewedAt}`, so nobody could tell
which process held it.

## Diagnosis

Read-only prod reads (a temporary probe script, since deleted) on 2026-11-16:

- Lease row sampled 04:48–04:49Z: owner `4b34be7d`, renewed every 20 s, previous
  release at 04:45:47.
- Every validator run starts its fixture workflows on the run-unique Temporal queue
  `navi-prod-migration-validation-<runId>`, and closed executions stay in visibility.
  Listing them gives the validator timeline. On 11-16 there were back-to-back runs at
  02:42–02:48, 02:48–02:54, 02:54–03:00, 04:26–04:32, 04:33–04:39, 04:39–04:45 and
  04:45–(running). These match the owner hand-offs observed: 73d208ac at 02:45,
  0f137cca from 04:33, 6752c0ad from 04:39:25, and 4b34be7d from 04:45:52. Each run
  holds the lease about 6 minutes, and the 2 s pollers re-take it within 20 s of each
  release. A waiting lane can lose that race repeatedly until its 10-minute budget runs
  out.
- On 11-15 no validator ran between 04:56 and 07:12Z, yet the lane timed out at about
  06:45–06:55 and 06:57–07:08. During those windows GitHub Actions `deploy-agents.yml`
  cooperative cutovers held the lease: run 43685886937 from 06:32:44 to 06:45:41 and
  run 43686763340 from 06:44:19 to 07:12:00. That cutover lasted about 28 minutes,
  longer than the lane's whole wait. The owner `f52be02e` seen at 07:08:11 was run
  43686763340, and the next validator started at 07:12:32, right after it released.
- Ruled out: a stuck or dead owner. Every owner renewed and released normally, so
  there was nothing to force-release. Also ruled out: the Render serverCron recovery,
  because no `deployment:existing-agent-worker-processes` intent exists.

Root cause: the lease worked as designed, serializing legitimate cutovers and
validations. Its row and errors carried no holder identity, though, so contention
looked like an anonymous stuck owner and could not be attributed.

## Solution

`workflowDeploymentLease.ts` now records `request.holder = {host, pid, purpose
(entrypoint script or explicit purpose), acquiredAt, githubRunId, githubRunAttempt,
githubWorkflow}` on acquire and keeps it on every renew. The existing `leaseMs` and
`renewedAt` fields are unchanged. Contention throws `WorkflowDeploymentLeaseBusyError`,
whose message names the current holder. PR #2336 (merged first) removed the validator's
use of the cutover lease altogether: each run now admits on its own per-run key, so the
validator neither waits on nor blocks real cutovers. That removed the validator
contention, and #2318 kept only the provider-level holder identity.
This adds no queries and grows one row by a few bytes, so behavior at 10k agents is
unchanged.

FIFO waiter queueing was considered and dropped: after #2336 the only remaining waiter
is worker-deployment-queue, which retries every 1 s with no deadline. That queue still
matches the busy message prefix, which is unchanged.

## Human feedback

The coordinator withdrew the earlier "f52be02e stuck for 22 h" claim: it was a
single sighting, and the "60 s cadence" was the observer's own poll interval. The
coordinator approved the identity fix.

## Reusable lesson

Every mutual-exclusion row must record who holds it (host, pid, purpose, CI run), and
every contention error must name that holder. An anonymous lease turns normal
contention into an unattributable "stuck owner".
