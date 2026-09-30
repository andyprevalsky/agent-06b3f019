---
id: 2026-09-30-disconnected-delete-verified-tree-before-sealing
date: 2026-09-30
title: Cloud cleanup checked a descendant deletion fence before a disconnected DELETE finished
surface: infra
component: owned-cloud-tree-teardown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py transport-error recovery demanded an immediately sealed tree while the accepted recursive DELETE was still running
symptoms:
  - "exact root database evidence is incomplete"
  - "Cloud cleanup failed: provider"
tags:
  - cloud-fleet
  - teardown
  - ownership
sources:
  - PR #1299
  - fleet run 20260930-125939-7453
  - agent d533ada0-3e1b-4198-900c-5254a9533d06
repro: agents/benchmarks/cloud_batch_cleanup_test.py
status: mitigated
---

## Problem

The unchanged mass-agent smoke evaluated under the temporary five-minute
execution ceiling, then its cloud finalizer failed provider and payment checks
with incomplete root database evidence. Its pre-delete snapshot and archive
were valid. This was an INFRA result and the slice received no credit.

## Diagnosis

Direct read-only queries against the original guest database showed the exact
root and its 51-agent tree still existed, with a valid owner and zero browser
sessions or purchases. The root was deleted at 13:18:16.653 UTC; the last
descendant was deleted at 13:20:39.616. The canonical recursive DELETE continued
for 2m 23s while its HTTP request had a 30-second bound. The transport-error
handler immediately demanded `require_deleted=True`; it could observe the
accepted operation between root deletion and completion of its descendant
fence. Provider release correctly refused that incomplete authority.

## Solution

After a disconnected DELETE, keep the owned stack alive and poll the same
exact root database for at most 180 seconds. Pin its owner and retain every
previously owned tree ID. Preserve the last observation and require a fresh
strict deleted-tree read before any provider fallback. Changed/missing identity,
malformed sealing evidence, or deadline exhaustion still fails closed. Ordinary
successful DELETE paths gain no polls; task budgets and evaluator results are
unchanged. At scale, this work remains bounded to one owned subtree.

The permanent repro failed before the fix with the same incomplete-evidence
finalization error. It now preserves the ordinary FAILED verdict after the
simulated accepted DELETE finishes sealing. Negative tests reject owner drift,
lost descendants and malformed snapshots, and prove the deadline grants no
provider authority. All 29 cloud cleanup tests pass. An unchanged live cloud
rerun and the ten consecutive slices remain required.

## Human feedback

Task FAILURE is allowed; incomplete provider/payment retirement is INFRA. Keep
the temporary five-minute task limit and independent 30-minute E2E cutoff.

## Reusable lesson

An interrupted HTTP response does not cancel an accepted backend operation.
Observe its exact ownership fence before deciding whether recovery may proceed.
