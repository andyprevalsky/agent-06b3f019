---
id: 2026-11-02-smoke-selection-exceeded-single-fleet-capacity
date: 2026-11-02
title: A selected smoke inventory exceeded the single-fleet provider admission limit
surface: infra
component: deploy-test-cloud
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet counted the complete selected inventory as simultaneous provider demand
symptoms:
  - Benchmark concurrency is limited by provider rate limits: requested 17 concurrent benches, maximum 16.
  - expected exactly one request-owned cloud fleet
  - worker result identity/inventory mismatch
tags:
  - smoke
  - cloudbench
  - admission
  - campaign
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb
repro: scripts/tests/deploy-test-worker.test.py CloudCampaign.test_execute_seventeen_tasks_crosses_real_capacity_and_receipt_boundary
status: open
---

## Problem

Attempt 12 selected 17 smoke checks, including grep-agent-trajectories-code-tool-status.
The native launcher exited 78 after about 2.8 seconds: 17 simultaneous tasks exceeded
its configured 16-task Tilion admission cap (20 sessions less 20 percent production
reserve). There was no fleet and no native task outcome. The adapter then reported
missing fleet, and the outer receipt reported an identity/inventory mismatch.
All 17 occurrence IDs and original fields are preserved in the private evidence
export occurrences.json; their common native receipt was compared before grouping.
This is not evidence of a provider outage or exhausted credit.

## Diagnosis

The selected inventory was treated as one simultaneous fleet. The old Hub caller
and current native caller both route this same 17-task inventory to unchanged
run-bench and run-bench-fleet code, whose unchanged provider-capacity guard refuses
before resource creation. Actual base and candidate script replays both returned
78 with the exact native refusal; comparison.json records their hashes and times.
This establishes NOT_INTRODUCED for the native admission refusal relative to
6f3f53201faac3a3e70de099e7c211cee6770fad. The new adapter's loss of the useful refusal
behind a missing-fleet message is a separate introduced reporting behavior.

The owning-boundary fixture exercises the real capacity checker and native child
provenance/lifecycle validators. The unchanged test fails on the frozen adapter
(all 17 UNVERIFIED) and passes on the proposed adapter. This is admission/receipt
causal proof, not proof of any of the 17 benchmark outcomes. Archive searches for
"Benchmark concurrency is limited" and "preflight smoke fleet concurrency" found
broad relatives; no direct prior case was established. Golden reference: not
applicable (no approval-gated hunk). No prompt edit is proposed.

## Solution

Private patch only: keep single-fleet behavior when selected demand fits capacity;
otherwise use the existing foreground campaign CLI with one run of every selected
task and its concurrency bounded by the unchanged provider registry. Reuse native
terminal_task and existing child collection validators, and require full job
inventory, no retries, unique request-owned fleets, terminal group publication ACK,
and both child and parent cleanup evidence. Preserve queued/missing/invalid work
as UNVERIFIED and genuine native failures as FAIL.

The patch is not integrated or deployed. Fifteen focused tests passed five
consecutive runs; boundary-before.log and boundary-after.log record the unchanged
assertion's fail/pass. Full unchanged smoke outcome proof remains the deploy
owner's work. No assertions, task definitions, deadlines or provider caps changed.

## Human feedback

The user restricted this investigator to evidence collection and private fixtures,
reserved deployment/source ownership to the parent, prohibited another deploy or
full gates, and required Freedom to remain protected. The coordinator requested a
private patch for the bounded campaign and native receipt collection; no parent
source files were modified.

## Reusable lesson

Keep selected task inventory distinct from simultaneous provider demand and verify every scheduled task through its native terminal and cleanup receipts.
