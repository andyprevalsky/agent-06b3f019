---
id: 2026-10-06-live-inventory-freshness-miss-aborted-autoscaler
date: 2026-10-06
title: A transient shared inventory miss aborted a live benchmark autoscaler
surface: infra
component: cloudbench-inventory-autoscaler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: inventory_machine_exists collapsed transient feed freshness and fatal publisher ownership failures into status 2
symptoms:
  - an expired feed terminates an autoscaler while its benchmark child and publisher remain alive
  - a temporarily missing health read creates a durable autoscaler failure before fresh inventory can return
tags:
  - cloudbench
  - inventory
  - autoscaler
  - ownership
  - stage-readiness
sources:
  - PR #1299
  - commit 83e02e99ae6c75ea8e8cf860a72c9028cf619a96
  - agent /root/fresh_claude_monitor_qualification
repro: agents/benchmarks/worker_capacity_loop_test.py
status: fixed
---

## Problem

Shared inventory refresh already retains its last good generation while bounded
provider requests retry. The autoscaler nevertheless treated both an expired
generation and a missing health read as fatal publisher failures. This could
terminate a healthy benchmark before the existing stage or child lifecycle ended.

This case establishes the inventory mechanism through an offline owning test. It
does not attribute the separately retained multi-workstream failure to inventory,
and it supplies no live benchmark outcome or cloud timing acceptance.

## Diagnosis

The path is shared publisher health → keyed Machine existence reader → actual
autoscaler loop → durable `autoscaler.failed` → benchmark lifecycle failure.
The first bad boundary is the existence reader: it returned status 2 for both
transient freshness loss and invalid ownership. The autoscaler immediately wrote
a fatal marker for that status.

Two archive searches used the literal unhealthy-inventory symptom and
expiry/freshness vocabulary, then duplicated native inventory, live publisher,
fail-closed and rate-limit vocabulary. The shared campaign inventory publisher
case supplied the existing ownership and no-fanout constraints. The failed-cohort
canary and moved-helper extraction cases supplied lifetime and actual-source-test
leads. None proved this boundary; this is a related contract error rather than a
recurrence of duplicated publishers.

The existing `worker_capacity_loop_test.py` now executes the actual sourced
inventory reader and actual autoscaler, with the existing independent supervised
benchmark child and local transport fixtures. An observation wrapper records the
real reader's return code without changing it. The transient controls keep the
feed unusable until that observation occurs, require the autoscaler to remain
alive without capacity calls, restore a fresh generation, and require the existing
ready-worker and child-settlement assertions. The three original capacity controls
and three fatal inventory controls remain in the same test.

The unchanged production revision produced **6/8 passing controls**. Expired
inventory and a missing health read each exited 1 before independent child
completion, with zero capacity calls; both failed
`transient-inventory-aborted-live-autoscaler`. Dead publisher, wrong token and a
primary absent from healthy inventory remained correctly fatal. The identical
eight controls produced **8/8 passing controls** with the repair. All recorded
native owners were absent after both runs, with zero network/provider/model calls.

The owning command was the repository Python interpreter, `PYTHONPATH` pointing
to this candidate's `agents`, and:

```sh
python -m pytest agents/benchmarks/worker_capacity_loop_test.py -q --basetemp=<private-receipt-directory>
```

Private commands, original failure output, native ownership receipts and test
digests are retained under
`.context/fresh-basic-claude-final50-20261006/deploy/monitor-inventory-repair.private/`.
Raw logs and process identities are excluded from this archive.

## Solution

Health checks first retain the publisher token and native process birth fences,
including the campaign parent when borrowing its feed. Missing or unreadable
health and finite expiry return retryable status 75. Invalid token, malformed
metadata, invalid Machine identifier, nonregular/symlink health, dead publisher
and wrong process birth remain fatal. An empty or invalid health record is not
classified as a transient generation.

The existence reader preserves this distinction. Both existing autoscaler
inventory checks warn and retry status 75 under the existing child/stage lifecycle.
The run loop clears scale-down timing and skips the capacity path until inventory
is fresh again. It never consumes stale inventory for new capacity and never fans
out a failed shared read into per-child provider calls. Healthy inventory proving
the primary absent still fails immediately.

The existing compact deploy selector already discovers this capacity test. The
existing `autoscaler_runtime_handoff_permanent_gate` in the agents benchmark
blackbox domain now includes that same file, so agents coverage and the ordinary
cloudbench deploy domain exercise the permanent controls. Combined mandatory
release qualification belongs to the release owner; this isolated repair does not
claim it has run the complete deploy domain.

Initial publisher refresh remains unchanged: its current status does not
distinguish transport errors from authentication or malformed publication. This
repair adds no guessed initialization retry, new environment setting or deadline.
Actual campaign publisher process death retains its existing abort/join handling.

## Human feedback

A stage must become usable for the next stage within the overall budget.
Transient observations within a stage should warn and continue, while genuine
ownership corruption, publisher death, lost resources and the agreed overall
cutoff remain fatal. Do not tune many small timeouts or add verification gates.
Preserve the unchanged cached task, execution budget and end-to-end budget; do not
claim a proxy test proves the eventual live benchmark outcome.

## Reusable lesson

Failing closed on stale inventory means withholding capacity mutation until a
fresh generation arrives. It does not require treating a live publisher's
temporary availability or freshness miss as an ownership catastrophe. Preserve
the distinction at the reader boundary so lifecycle owners can retry safely.
