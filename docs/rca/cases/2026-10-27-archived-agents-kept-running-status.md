---
id: 2026-10-27-archived-agents-kept-running-status
date: 2026-10-27
title: Archiving (soft-deleting) an agent set only deletedAt, so 16k archived agents stayed ACTIVE/PAUSED forever
surface: back-end
component: agent-kill
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/agentKill.ts deleteAgentRecursiveInternal — the sealing transaction wrote only { deletedAt } and left the agent's non-terminal status
symptoms:
  - soft-deleted agents with status ACTIVE or PAUSED
  - archived agent restored by unarchive still shows ACTIVE
  - 16,045 archived non-terminal agents in prod
tags:
  - agents
  - archive
  - status
  - data-integrity
  - scale-100-seats
sources:
  - task Q7 of the 100-seat readiness audit (S17 priority 5)
  - commit 31d769b90 (reproduced on origin/main)
repro: back-end/src/tests/blackbox/agents-sidebar-organization.cases.ts
status: fixed
---

## Problem

Prod, read-only, 2026-10-27:
- Soft-deleted agents by status: ACTIVE 12,048, PAUSED 3,827, STARTING_UP 170.
- Of these 16,045 rows, 10,096 belong to a load-test user and 5,316 to the
  benchmark user.
- The liveness reconciler and every status reader exclude `deletedAt` rows, so
  nothing ever settles them.
- Unarchived agents come back showing "running", and raw analytics count them
  as live.

## Diagnosis

`DELETE /api/agents/:id`, the SMS kill and the parent stop path all call
`deleteAgentRecursive`. Its sealing transaction (under the workflow-generation
lock) wrote only `deletedAt`, then terminated the Temporal workflow outside the
transaction. Termination writes no status, so a STARTING_UP/ACTIVE/PAUSED row
kept that status permanently.

The new blackbox case archives an ACTIVE parent with a PAUSED child. It fails
with main's `agentKill.ts` (both rows stay ACTIVE/PAUSED) and passes with the
fix.

## Solution

- The sealing transaction also runs
  `updateMany({ id, status in (STARTING_UP, ACTIVE, PAUSED) }) → FAILED,
  "Archived by user"`.
  - This applies to each descendant through the existing recursion.
  - Already-terminal rows keep their status.
  - FAILED is irreversible for later worker status writes (`IRREVERSIBLE_STATUSES`),
    so a racing workflow cannot write ACTIVE back.
  - There is no CANCELLED status; adding one would be an enum and Zod change.
- Workflow termination is unchanged: idempotent, and "not found / already
  completed" counts as success.
- Backfill: `back-end/scripts/backfill-archived-agent-status.ts`, with the core
  in `providers/archivedAgentStatusBackfill.ts`.
  - It is a dry run unless `--execute`.
  - Each 1000-row batch selected by primary key runs in its own transaction
    with `lock_timeout` 2s and `statement_timeout` 15s.
  - It only touches `deletedAt IS NOT NULL AND status IN (non-terminal)` rows,
    so it is idempotent.
  - It is a script, not a migration, because `migrate deploy` failures block
    the Render release (see the S7 incident).
- Regressions (backend `agents` blackbox domain):
  - archiving a running parent and child gives FAILED, and an already-terminal
    agent is unchanged;
  - the backfill dry-run counts without writing, `--execute` settles only
    archived non-terminal rows, and a second run finds nothing.

Scale (10k agents): one extra indexed single-row UPDATE per deleted agent,
inside the existing transaction. The backfill touches at most 1000 rows per
short transaction.

## Human feedback

The parent (S17) required a terminal status on delete, confirmation that the
workflow is terminated, and a prod backfill only through a reviewed,
idempotent migration or script with statement and lock timeouts.

## Reusable lesson

A soft delete must also settle every lifecycle field that other code would
otherwise reconcile. Once readers exclude deleted rows, nothing else will fix
them.
