---
id: 2026-09-02-prod-migration-cold-handoff-timer-gate
date: 2026-09-02
title: Prod migration validation encoded a pre-handoff zero-timer contract
surface: harness
component: prod-workflow-migration-validation
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/validate-prod-workflow-migration.ts cold-history and activation-marker assertions modeled state that cooperative handoff intentionally no longer preserves
symptoms:
  - "cold_workflow_uses_no_resources_while_waiting"
  - "cost_limit_reached_preserved"
  - "out_of_credits_preserved"
  - "same_sha_old_marker_is_retired_without_retiring_current_attempt"
  - "WorkflowNotFoundError for navi-worker-deployment-activation:<merge-sha>:<run-attempt>"
tags:
  - workflow-migration
  - temporal
  - cooperative-handoff
  - activation-marker
  - harness-contract
sources:
  - PR #1197
  - commit 435f7093f
repro: back-end/scripts/validate-prod-workflow-migration.ts --execute
status: fixed
---

# Prod migration validation false-failed on cooperative handoff timers

**Date:** 2026-09-02
**Deploy:** PR #1197 post-merge Step 13ac
**Class:** harness-contract-drift / fixture-environment-data-mismatch

## Problem

`PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1 npx tsx scripts/validate-prod-workflow-migration.ts --execute` failed 4 rows after a successful cooperative Fly cutover:

- `cold_workflow_uses_no_resources_while_waiting`
- `cost_limit_reached_preserved`
- `out_of_credits_preserved`
- `same_sha_old_marker_is_retired_without_retiring_current_attempt`

Cold rows asserted `timers:0 → timers:1` (and matching workflow-task/event growth) over a 1–2s observe window. The marker row failed with `WorkflowNotFoundError` for `navi-worker-deployment-activation:<merge-sha>:<run-attempt>`.

## Evidence

- Prod validation JSON retained under `/tmp/prod_workflow_migration_validation.txt` (deploy run after merge `435f7093f…`, token `33592438361-1`).
- Live pointer after cutover: `navi-agent-tasks@4b82919d925b`; old queue drained to `open=0`.
- Post-failure probe: **zero** running `RoseWorkerDeploymentActivationMarker` workflows; current deploy marker ID not found.
- Code path for restored paused agents (`agent_workflow.py`): after bootstrap READY, `_wait_for_unpause_or_handoff` runs `fetch_agent_queue_pointer` then `workflow.wait_condition(..., timeout=30s)` — which **schedules a durable TimerStarted** immediately.
- Stale comment above that call claimed "Consume no workflow timers or activities" — contradicted by the handoff helper (cooperative cutover design).

## Diagnosis

1. **Cold history gate raced handoff arming.** Validation sampled history immediately after READY, then again 1–2s later. READY is published in `finalize_workflow_replacement_bootstrap` *before* the first handoff wait timer is scheduled, so the observe window often captured the intentional cooperative-cutover timer/activity and failed a "zero growth" assertion that predated paused handoff polling.

2. **Activation-marker check assumed leftover deploy state.** Cooperative cutover does not leave `navi-worker-deployment-activation:<sha>:<token>` running after deploy. The test only minted the *old* marker and then `describe()`'d the missing current marker.

## Solution

Validation script + RCA only in the follow-up PR (comment correction in `agent_workflow.py` deferred so a comment-only edit does not force another surface-hash generation rollover).


- Settle cold history until `timers >= 1` and counts stop moving, then assert no further growth inside the 30s poll window (`assertColdHandoffHistoryStable` in `validate-prod-workflow-migration.ts`).
- Mint the current activation marker inside `same_sha_old_marker_…` before creating the superseded one.
- Correct the outdated cold-pause comment in `agent_workflow.py`.

## Local repro / proof

```bash
cd back-end
PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1 \
  TEMPORAL_TASK_QUEUE=navi-agent-tasks \
  TEMPORAL_WORKER_BUILD_ID=<merge-sha> \
  TEMPORAL_WORKER_DEPLOYMENT_TOKEN=<runId>-<attempt> \
  npx tsx scripts/validate-prod-workflow-migration.ts --execute
```

- **Before:** 4 FAIL rows as above.
- **After:** all rows PASS (re-run on fixed revision).

## Prevention

Prod migration validation must encode the cooperative-cutover cold contract (bounded handoff poll), not a pre-cutover "literally zero history events while paused" reading. Marker lifecycle tests must be self-contained.

## Human feedback

None recorded.

## Reusable lesson

Make migration validators create and settle the complete current lifecycle state instead of asserting obsolete zero-history or leftover-marker assumptions.
