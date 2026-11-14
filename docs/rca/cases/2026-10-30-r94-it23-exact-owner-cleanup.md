---
id: 2026-10-30-r94-it23-exact-owner-cleanup
date: 2026-10-30
title: It23 seven retained owners recovered through canonical guest and runtime checks
surface: infra
component: cloudbench-exact-owner-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Seven original cleanup lifecycles failed and retained guest and runtime ownership latches
symptoms:
  - guest-cleanup-unconfirmed
  - runtime-evidence-unconfirmed
  - FAILED lifecycle with retained ownership
tags:
  - r94
  - it23
  - cleanup
sources:
  - commit fc00b583e7df7b94d05fdb3442bddd23cd21be8b
repro: none-recorded; original custody and authorized canonical recovery receipts
status: open
---

## Problem

After It23's operational stop, seven original owners retained both guest and
runtime latches without sealed normal manifests. Original5PASS/4FAIL/11CANCELLED
and10verified/7FAILED lifecycle records remain immutable. Recovery is a later
operational disposition; it does not make those original failures pass or
establish their underlying causes.

## Diagnosis

The exact source was fc00b583e7df7b94d05fdb3442bddd23cd21be8b. All301 supplied
manifest-listed files across seven packets were independently size/SHA checked,
including registry and port bindings. Each owner had one owned fresh primary,
no pool entry, and donor683e47df5094d8. Extracted canonical guest-plan code ran
offline with only scratch paths relocated: all seven returned rc0 and one
nonempty guest row. Unlike the earlier R89 retired-owner case, none was an
empty-plan shortcut. Original R89 Solution and Human feedback were read.

Retain plus a latch selects quarantined recovery. The normal entry requires
same-host dead-controller identity, locks, current exact native identity and
configuration, authenticated cleanup and runtime verification before teardown.
The offline planner did not prove live guest reachability or discharge either
latch. Initial controller/lock observations were owner-local attestations.

## Solution

No runtime patch, manual ACK or latch edit. The coordinator authorized seven
sequential once-only canonical commands with unchanged defaults:
`bash scripts/run-bench-fleet --ref fc00b583e7df7b94d05fdb3442bddd23cd21be8b --recover-stale-owner <exact owner>`.
The launch owner executed them; this investigator made no native or guest call.
Each returned rc0. Reopened full canonical and mirror trees matched these
20-file digests; each original FAILED lifecycle remained byte-identical:

| Job | Exact owner | Canonical/mirror SHA256 |
|---|---|---|
| r001-j0001 | 0fc58665e97e4bd7984330fb104b4005 | 2716870f599a877d94a06d5950dc644d6e45bc1fb389f5b41b67e2d7be134d57 |
| r001-j0002 | 39ed544c2c574efaad07a0fa348db83d | 508c3109742c97ac578a50c28a0891a1c9ca56bbdf3a0ad7893e56a0abe95967 |
| r001-j0003 | 366988cfa6354934ba8ec671cda68ea1 | 0180d2090be7235dbf3c3dc4ae28f269395ff500b1547b1c1322467313f659a9 |
| r001-j0004 | 42ebedc0a7dd42b7a695f48e78516297 | 4bf8902c31a16c834a9929af6a2b27e38520f2a0a6ba9e045cace143dce905e5 |
| r001-j0005 | da831e2c7ad34f18957fc7e8ee08558a | b7cdbf3b1032c5a0704c9c60e6ee2a98539440f08f06ae9b5e6a4e09b1faa36d |
| r001-j0008 | 90df999d36b94d0e833f733c91cdd689 | dafda636e9ba7c572ce025ea5acfa1cf6bd5e4ed4b57bc13fe40620dc4528319 |
| r002-j0013 | 05f9f53d781744bd9206d5a59325867d | cbb4a3c72e42aded486b3aab2e37b61996134b120407920532d7d4489df4b7ee |

The accepted17-owner aggregate at1793323078.505742 has SHA256
49b46ec96e9cf34655265b2a73b2159b7c2d6d57c8bf4c73c8a1d40057855302.
The parent matched all17 expected canonical digests: the original10 and new7.
All17 current mirrors and registry absence were checked by the owner locally;
this investigator independently reopened the seven returned trees and matched
all seven to the aggregate. This proves scoped post-recovery release under the
canonical checks. Provider-retained terminal records are not universal native
object absence. Original17 lifecycle hashes/statuses remain10verified/7FAILED;
summary197d939730585d1e5c3803c7ca044ec500c73f007b5af973856915ef09e8b932
and5PASS/4FAIL/11CANCELLED are unchanged. No finish-time release credit, task
qualification or root-cause-fixed claim follows from the later recovery.

## Human feedback

The coordinator required exact per-owner plans and original-byte preservation,
prohibited the earlier empty-retired shortcut, and held this final record until
all seven actual results and the aggregate were accepted. Only the launch
owner had operational authority. No new task, model replay, provider query or
runtime test was performed by this investigator. Tokens UNMETERED.

## Reusable lesson

Validate each retained owner's actual guest and runtime obligations, then
record later operational release separately from original failed outcomes.
