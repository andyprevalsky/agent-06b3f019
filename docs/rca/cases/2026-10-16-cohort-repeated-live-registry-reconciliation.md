---
id: 2026-10-16-cohort-repeated-live-registry-reconciliation
date: 2026-10-16
title: Every sealed cohort member rescanned all live fleet registries
surface: harness
component: cloudbench-stale-registry-reconciliation
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet reconcile_stale_fleet_registries walks the shared ownership root independently in every cohort controller
symptoms:
  - "host_load 1146.04 790.68 387.70"
  - "sed -n s/^host=//p cloudbench-fleet-ownership/*/meta"
  - "all 601 cleanup reservations committed but N2 remained before native creation"
tags:
  - cloudbench
  - concurrency
  - startup
sources:
  - PR #1525
  - benchmark run Attempt57 monitor-1792187478874154949.private.json
  - benchmark run Attempt57 monitor-1792187663543430388.private.json
repro: python3 scripts/tests/cloudbench-cohort-reconcile.test.py
status: open
---

## Problem

Attempt57 completed all 600 ordinary cleanup reservations plus the one N2 slot,
but startup remained CPU saturated before N2 native creation. The saved monitor
reported 1161 runnable processes out of 1824 on eight CPUs, load 1146.04, and
25.2 GB available memory. Five-second root-owned samples then captured the N2
controller's descendants repeatedly running sed/head against peer registry
host/version fields. This locates actual work inside the historical registry
scan, rather than inferring a dependency-fingerprint hang from changing PIDs.
The active run was preserved and this patch was prepared independently.

## Diagnosis

The path is sealed campaign dispatch → independent fleet reservation → warm
proof → stale-registry reconciliation → required N2 → native startup. Each
controller publishes its registry before reservation, then scans every other
registry before N2. Each live peer requires four metadata reads, cleanup-policy
classification, then three further reads for exact owner liveness. Each metadata
read launches sed and head. With 600 present peers the source upper bound is
600×599×7×2 = 5,031,600 external executions, plus command substitutions. This is
a finite quadratic startup pass, not a no-sleep fingerprint loop. The exact
execution count and total wall-time attribution were not measured.

Archive searches for `registry scan` and `startup CPU contention` found a related
shared-inventory-publisher case, not this registry loop. The prior inventory
repair shares app-wide reads; this incident independently duplicates historical
cleanup work. The root-owned runtime samples and the unchanged scanner local
three-controller reproduction establish this boundary. Original code enters the
full scanner three times where the regression requires one.

## Solution

Unify the existing reconciliation at its sealed-cohort ownership boundary.
One exact assigned controller holds a persistent cohort kernel lock through the
unchanged full scanner and its durable completion. Other members block in the
kernel, revalidate their selected ticket, live parent, app, host, ownership root,
source bytes and lock inode, then consume that cohort's result. A failed scan
publishes failure, never success. A dead or exact zombie winner without a
completion allows the next owner to run the original safe scanner again;
live or uncertain winners do not grant recovery. Standalone and explicit reuse
behavior remains unchanged. Cached consumers conservatively require the
existing post-recovery inventory refresh.

This deletes repeated cohort work rather than throttling physical allocation.
The full scanner remains necessary for foreign, unknown, retained and historical
owners and its destructive guards are unchanged. The ordinary cached path reads
constant selected-ticket and completion metadata, without walking registries.
At 10,000 members there is one full historical scan per cohort, not 10,000
scans; cohort initialization and that cold historical scan remain proportional
to their own input sizes. No production 10,000-task or latency claim is made.

The original three-controller command fails with `AssertionError: 3 != 1` on
the immutable original fleet. The unchanged command passes on the repair.
The registered owning test runs the actual Bash wrapper and scanner with real
process identities and kernel locks. It covers concurrent members, live-winner
waiting, death before completion, failed/unknown ownership, preserved foreign
and retained bytes, and unchanged standalone scans. The RCA remains open until
a subsequent unchanged benchmark verifies this production boundary and its
complete outcome. No current-run edit, provider call, task change, new benchmark
gate, timeout extension or automatic run restart is part of this repair.

### Follow-up: coalesce the immediately adjacent orphan sweep

Attempt57 subsequently moved past the peer metadata scan into the next original
startup operation: `ps -o pid=,ppid=,command= -ax` in
`reap_orphaned_fleet_proxies`, captured by monitor-1792188157798341426. That
unchanged app-scoped orphan sweep now runs in the same successful cohort winner,
after historical reconciliation and before its completion receipt. Its exact
process identity/signal guards and original ignored-return behavior remain
unchanged; standalone and explicit reuse still execute their original sweep.
A failed registry scan cannot enter the sweep. The owning counters require one
sweep across three cohort members and three sweeps for three standalone callers.
This removes a second repeated global scan without introducing allocation
batches. The active run was not patched or restarted.

## Human feedback

The user required fully parallel reservation/startup without artificial batches;
only actual rate limits should impose backoff. This fix shares duplicated
historical work rather than limiting member allocation concurrency.

## Reusable lesson

Coalesce shared historical reconciliation at the sealed cohort boundary while preserving exact owner and mutation guards at every destructive action.
