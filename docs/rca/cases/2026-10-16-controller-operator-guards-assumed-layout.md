---
id: 2026-10-16-controller-operator-guards-assumed-layout
date: 2026-10-16
title: Retained-controller operators assumed workspace identity and process state
surface: harness
component: cloudbench-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: private controller-adoption and maintenance guards inferred process privileges and preserved layout from workspace defaults
symptoms:
  - original init identity/state differs
  - Permission denied
  - No such file or directory
  - linked original child directory
  - flyctl not found on PATH
tags:
  - cloudbench
  - controller
  - preservation
  - ownership
sources:
  - PR #1525
repro: agents/tests/blackbox/benchmark.blackbox.py controller_maintenance_* records
status: mitigated
---

## Problem

Seven independently observed private operator failures blocked the retained
controller continuation. A root-owned init and root-private original seal lived
beside a user-owned checkout; old registry paths were legitimately absent;
preserved inventory contained links and special files; a fresh operation parent
did not exist; scheduler state changed while stop was pending; and SSH omitted
the already-retained transport executable from PATH. Fixing each private copy
left no permanent runner coverage.

## Diagnosis

Archive searches used `controller adoption uid preservation` and `flyctl PATH
stopped process scheduler state`. Existing root-capability, inherited ownership,
and retained-endpoint cases were related but did not cover these assumptions.

The permanent fixture manifest records each actual buggy source SHA, the exact
AST or shell-boundary extraction, and consistent redaction. Full private scripts,
credentials and native resource IDs are not published. Historical adapters run
only these captured fragments against local files, controlled process rows and
mocked privilege boundaries. They are not deliberately broken replacement
implementations. The seven permanent `r.record` cases all fail on those original
boundaries, then pass unchanged against the shared controller-export guards.
The initial focused harness omitted the runner's standard environment defaults;
that setup failure was corrected before the valid RED run.

Sanitized process facts retain UID0 init versus UID1001 workspace, and the
inventory keeps the actual absent/present and symlink relationships. The
scheduler sequence is a controlled adversarial transition, not a claim about an
unrecorded instantaneous state. The privilege test is an explicit capability
model on non-root Linux; it never demotes the test process or claims a real root
integration result.

## Solution

The existing controller-export owner now exposes reusable guards for separately
bound process identity, typed preservation inventory with explicit absence,
child-only privilege demotion, private exclusive operation-directory creation,
bounded exact-process stop transitions, and retained executable verification
with a child-only PATH. Unknown identities and changed preservation evidence
remain refusals. Links and FIFOs are inventoried without traversal or reading.

New `controller_maintenance_*` entries are registered directly in the benchmark
blackbox domain. Focused actual-registration RED/GREEN receipts and frozen test
hashes are retained in the isolated worktree's `.context/operator-guards`.
The final actual `run_all_tests()` selection executes all ten records: the
unchanged test/source hashes produce ten failures with the captured selectors
and ten passes with the corrected implementation. Full-domain completion
remains a separate gate until its runner receipt passes.
Three later V39 records additionally cover the full native-pair selection,
receipt-bound runtime directory, and PID1/all-UID writer classification. Their
unchanged actual `run_all_tests()` registration route is RED separately for
each captured bad selection/predicate and GREEN for all three; the cleanup
adapter preserves the exact old PID1 sleep assertion recovered from the
original tool-call source. See the V39 fixture provenance rather than treating
a constructed defective helper as historical code.
Private thin caller templates are prepared in the isolated worktree and bind
the shared exporter by exact SHA before use: adoption delegates identity,
inventory and child privileges; supervisors delegate identity, bounded stop
and transport environment; the driver delegates exclusive mkdir; V39 runtime
observation delegates its complete original binary/lib/bridge/package checks.
Root must bind and adopt the new source before using them. Existing running
operators remain untouched, and no native reuse or REAL600 result is implied.

No deployment-discovery change was needed: existing Step4cb matches
`cloudbench-controller-export.py` and directly runs the benchmark blackbox domain
when agent changes are absent. When agent files change, Step4g owns that domain
and Step4cb waits, avoiding duplicate parallel ownership.

## Human feedback

Preserve original evidence and all data. Use identical permanently registered
RED/GREEN cases; private scratch tests alone are insufficient. Never infer
idleness, clear latches, create capacity, or weaken ownership guards to pass.

## Reusable lesson

Operator preflight is part of the maintained runtime contract. Bind each
observed identity and filesystem kind explicitly and keep one tested guard
implementation, rather than inferring them from a nearby workspace or PATH.

## Validation environment correction

The initial broad benchmark-domain attempt lacked the complete private env in
its isolated worktree. The runner populated its documented test-only OpenRouter
key, while declared-judge cases intentionally execute a real provider route;
those calls returned 401. The attempt was interrupted and preserved, not called
GREEN. Complete existing private env files were then restored following
CLAUDE.md, with a unique Temporal queue and no secret output or commits. A fresh
local config comparison proved the selected key matched the authoritative env
before one controlled full-domain retry. That retry's outcome is retained
separately from the deterministic operator cases. The first focused harness
missing TEMPORAL_API_KEY was likewise an invocation setup error, fixed by using
the runner's actual apply_test_env_defaults before the valid historical RED.

The controlled full-domain retry completed in 230.3 seconds with exit 1. Its
remaining failures are in two existing fixture families:
`private_fleet_source_permanent_gate` (six failures involving omitted
`campaign_inventory_*` dependencies, an unset `GIT_COMMON_DIR`, and resulting
post-recovery admission assertions) and `cloudbench_pool_vm_shapes_permanent_gate`
(one unset `GIT_COMMON_DIR` failure). These are retained as open full-suite
failures, not counted as operator-guard regressions or original REAL600 causes.
The retry also logged recovered provider fallback and local archive connection
errors; those logs remain retained and do not establish successful remote archive
or original-run qualification. No additional paid full-suite retry was made.

The two failed fixture families were subsequently corrected without changing
assertions: extracted fixtures now include their actual inventory/reuse helper
dependencies and physical Git-common-directory input. Re-running the identical
registered families passed 168 private-fleet cases and 14 VM-shape cases. The
original full-domain failure remains preserved; this is a targeted rerun of its
only failures, not a replacement full-domain success claim. After integration,
the ten new operator records and five runtime-latch cases each passed five
consecutive runs with identical source and test hashes. Native adoption and the
original REAL600 run remain separate, pending qualification steps.
