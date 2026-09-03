---
id: 2026-09-02-prod-migration-cold-handoff-timer-gate
date: 2026-09-02
title: Prod migration validation false-failed on cooperative handoff timers
surface: harness
component: validate-prod-workflow-migration cold handoff history gate
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: validate-prod-workflow-migration.ts cold history gate sampled before cooperative handoff timer armed and assumed leftover activation markers
symptoms:
  - cold_workflow_uses_no_resources_while_waiting FAIL timers 0→1
  - cost_limit_reached_preserved / out_of_credits_preserved FAIL
  - same_sha_old_marker_is_retired_without_retiring_current_attempt WorkflowNotFoundError
tags:
  - workflow-migration
  - cooperative-cutover
  - temporal
  - deploy-gate
sources:
  - PR #1197
  - memory:prod-migration-cold-handoff-timer-gate
repro: cd back-end && PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1 npx tsx scripts/validate-prod-workflow-migration.ts --execute
status: fixed
---

## Problem

Production workflow migration validation failed four rows after a successful
cooperative Fly cutover because cold-history sampling raced handoff arming and
the activation-marker check assumed leftover deploy state.

## Diagnosis

READY is published before the first handoff wait timer is scheduled, so a 1–2s
observe window often captured the intentional cooperative-cutover timer.
Cooperative cutover also does not leave the current activation marker running.

## Solution

Settle cold history until `timers >= 1` and counts stop moving, then assert no
further growth inside the poll window. Mint the current activation marker inside
the same-sha marker test before creating the superseded one.

## Human feedback

Post-merge Step 13ac validation failed after an otherwise healthy cutover;
failures were harness contract drift, not a bad candidate build.

## Reusable lesson

Prod migration validation must encode the cooperative-cutover cold contract
(bounded handoff poll), not a pre-cutover "literally zero history events while
paused" reading. Marker lifecycle tests must be self-contained.
