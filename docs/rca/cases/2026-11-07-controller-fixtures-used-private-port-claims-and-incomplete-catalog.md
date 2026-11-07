---
id: 2026-11-07-controller-fixtures-used-private-port-claims-and-incomplete-catalog
date: 2026-11-07
title: Controller fixtures used private port claims and incomplete timeout metadata
surface: infra
component: scripts/tests/cloudbench-multi-workstream.test.sh
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: independent fixture processes coordinate ports only inside their private TMPDIR and choose windows overlapping the kernel ephemeral range
symptoms:
  - "OSError: [Errno 98] Address already in use"
  - "FAIL hub stub must publish an exact owner record"
  - "autoscaler-worker-required lacks timeout_seconds"
tags:
  - staged-deploy-cycle
  - native-controller
  - port-allocation
sources:
  - PR #1716
repro: scripts/tests/cloudbench-fixture-port-allocation.test.py
status: fixed
---

## Problem

Gate: UNKNOWN for the original port collision. On source `1c0a5e56`, the
controller gate failed with the errors above. Its selected-pytest constituent
also correctly refused downloads with less than the unchanged 2 GB free-disk
guard. The original collision port and competing owner were not retained, so
the fixture reproduction does not establish that historical owner's identity.

## Diagnosis

Two native fixture processes with different TMPDIR values reproduce conflicting
claims on the same port window. The previous windows also overlap the actual
Linux ephemeral port range. A focused replay then exposed missing timeout
metadata on 40 synthetic tasks despite their existing command's 240-second
timeout. The new allocator regression's first cleanup implementation could
leave later children unjoined when an earlier communicate call timed out.

## Solution

Use a common, owned, private per-UID claim directory and stable flock inodes;
retain each descriptor through exact Hub cleanup. Bounded windows exclude the
actual ephemeral range and their derived conductor ports. Supply the existing
240-second timeout on synthetic tasks, preserving task identities, the 9000
sentinel and cancellation caps. Run regression children under the existing
subreaper, drain each owned tree on timeout, attempt every later child and
preserve the original failure. No assertions or timeouts were weakened.

The original allocator is RED under the two-TMPDIR regression; the corrected
allocator passed five serial and four parallel runs. Metadata regression and
actual policy CLI are RED then GREEN; the unchanged focused native fixture
passed at `5af5ac28`. The subsequent cleanup correction has five native passes
including a TERM-resistant child and detached descendant, plus four parallel
allocator passes. These focused receipts do not substitute for the complete
controller gate on the integrated source. All owned helpers were terminal.
Disk capacity was recovered from reproducible copies after their consumers
finished; original failed artifacts remain retained.

Approval: not applicable (no approval-gated hunk).

## Human feedback

The user required finishing deployment autonomously. Independent review found
the regression-child cleanup gap; the correction was reviewed without a new
concrete blocker. The historical collision attribution remains UNKNOWN.

## Reusable lesson

Independent native fixtures must share their allocation authority. A bounded
wait also needs exact-owned cleanup that continues after individual failures.
