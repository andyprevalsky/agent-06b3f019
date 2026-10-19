---
id: 2026-10-16-cold-empty-primary-return-rejected-before-plan
date: 2026-10-16
title: Cold borrowed-only cleanup rejected an empty fresh-primary return plan
surface: harness
component: run-bench-fleet current_registry_primaries_to_pool_plan
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: current_registry_primaries_to_pool_plan rejected every cold run before checking whether any fresh primary existed
symptoms:
  - 'fresh primary STOP/pool return was not verified; retaining exact ownership and data'
  - 'POOL_COLD_BOOTSTRAP=1'
tags:
  - cold-bootstrap
  - pool-reuse
  - empty-cohort
  - teardown
sources:
  - PR #1525
  - commit 4426b695b
  - fleet run 50; private v41-command-d29a9d67627cac68 and v41-command-95f3c0e8b8cf2e79
repro: scripts/tests/cloudbench-live-primary-return.test.py ColdEmptyReturn
status: open
---

## Problem

Run 50 completed both typed substrate probes, verified stopped returns, released both claims, and recorded returned-stopped-claim-released audits. It then failed the final fresh-primary cleanup branch even though registry clones and fresh/expected/by-machine audit directories were empty. The parent also had no fresh resource because no real task had started. Root retained both original outcomes and supplied read-only evidence; no provider operation was performed by the fix author.

## Diagnosis

The final cleanup invokes stop_current_registry_primaries_for_pool and return_current_registry_primaries_to_pool for a published registry. Their shared current_registry_primaries_to_pool_plan required POOL_COLD_BOOTSTRAP=0 before reaching the existing empty-plan handling. This blocked a safe no-op after successful borrowed resource return. It is distinct from the earlier refresh-to-normal-boot assertion, which no longer occurred. The local owning test executes the actual plan and both cleanup functions with canonical provenance; old source refuses before planning, while the corrected source performs no native read, STOP, proof write or transfer.

## Solution

Keep the normal fresh-primary contract unchanged. For cold mode, require the same exact live owner, joins, guest/runtime and latch checks, then prove all fresh ownership directories and ledgers empty. Every borrowed audit must have the exact canonical terminal schema, match this owner/run/app, and have no remaining claim; the current claimed-ID ledger must also have no outstanding claim. Only then use the unchanged provenance/dependency planner to produce an empty baseline-only plan. This also permits an aborted empty parent without falsely asserting task completion. Any fresh ownership, unfinished claim, changed identity or dependency mismatch still refuses. No allocation or provider action is added.

## Human feedback

The user requires existing Machine reuse and idle teardown while preserving all IDs, Volumes and data. Root required a narrowly verified no-op for the no-fresh cohort rather than accepting fresh cold allocations or bypassing unfinished borrowed claims.

## Reusable lesson

Prove that a resource cohort is empty before applying an operation-specific prohibition to its no-op cleanup path.

## Aborted-parent typed absence follow-up

Run 51 exposed a second assumption in the empty-cohort guard: it resolved the audit pool directory with strict existence before deciding whether the parent had ever claimed a resource. The captured parent had empty clones, fresh, expected-fresh and by-machine-id directories and empty owned ledgers, but neither an audit pool directory nor a claimed-pool ledger. Its task outputs had no `.cid`. Strict resolution raised FileNotFoundError and incorrectly added a cleanup failure to the preserved preflight failure.

The guard now accepts only that paired absence, checks the physical run directory and absence of child `.cid` records, and continues through the unchanged provenance planner. A present claim ledger, task `.cid`, symlink, regular-file pool path, or missing required fresh directory still refuses. No directories or records are created and no provider operation is introduced. The original child failure and parent outcome remain unchanged. The owning old-source test reproduces the missing-directory exception; the corrected actual plan/STOP/return chain passes without a native call.

Evidence: private `v41-command-eed7836df29c1558`, `v41-command-da325af09dc63281` and `v41-command-76145d057d5de652` packets. Live validation of this follow-up remains pending.
