---
id: 2026-09-30-pool-cpu-kind-validation-assumed-shared
date: 2026-09-30
title: Configured dedicated pool CPUs were rejected by shared-only admission
surface: infra
component: cloud-pool-vm-shape
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud claimed-pool shape argument validation and native verification hard-coded shared CPUs while fleet settings accepted performance CPUs
symptoms:
  - "invalid claimed-pool VM size"
  - "claimed-pool VM resize was not provider-verified before start"
  - "unexpected resize of large"
tags:
  - cloud-fleet
  - pool
  - cpu
sources:
  - PR #1299
  - fleet run 20260930-150047-9294
repro: agents/benchmarks/cloudbench_vm_shape_test.py
status: mitigated
---

## Problem

The fleet's explicit primary CPU settings accept performance presets, but pooled
boot configuration rejects them before starting a guest. Its native-resource
fence also assumes shared CPUs. Dynamic pool normalization would shrink an
already admitted dedicated 8 GB member, while claim selection and boot-update
selection could not recognize an exact dedicated match. No benchmark scoring
or agent behavior is involved.

## Diagnosis

The dedicated comparison observed nine native stopped performance-1x/4 GB
members. One separate host rejected its CPU reservation, so proof76 stopped
before allocating any benchmark. Investigating the remaining boot path revealed
the next refusal: the argument regex permits only `shared-cpu-*`, and successful
provider validation compares against `stopped shared ...` regardless of the
configured preset. These are distinct from the provider's host capacity error.

Archive searches were `invalid claimed-pool VM size performance` and
`dedicated CPU pool shape shared`. Capacity-rejected guest recovery is related,
but neither search identified this shared-only type assumption as a prior case.

The permanent reproduction executes the real argument and verification blocks
against native resource fixtures. Its unchanged command is
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_vm_shape_test.py`.
Before the fix: **4 failed, 10 passed**, including exit 70 with
`invalid claimed-pool VM size` for the correctly requested dedicated fixture,
an unnecessary resize of the admitted dedicated 8 GB fixture, selecting an
earlier shared candidate instead of the exact dedicated candidate, and requesting
a boot resize for an already exact dedicated shape. This proves
the owning resource-contract defect; it does not prove the earlier mass-agent
archive timeout was caused by CPU quotas.

## Solution

Accept the same shared/performance preset families throughout pooled boot
admission. Derive native CPU kind and count from the requested preset for
verification, preferred claims, boot-update selection and retention of admitted
large shapes. All stopped-state, count, memory and ownership checks remain
mandatory. Defaults, task definitions, deadlines and evaluators are unchanged.

The identical reproduction now reports **14 passed**. It rejects wrong CPU
kind, count, memory, native running state and unsupported preset names, and
preserves both shared behavior and admitted dedicated shapes. Exact dedicated
claims take priority, while kind/count/memory mismatches still request a boot
resize. It is wired into
the owning benchmark blackbox's permanent pool-resource gate. The separate
terminal-evidence gate retains its existing checks and deadline. Live canonical
guest startup and the unchanged ten-slice acceptance remain pending, so this
case is not reported as a completed benchmark fix.

Proof77 on a1363effb subsequently verified all ten canonical guest starts,
ordinary task results and exact guest/provider retirement with the configured
dedicated profile. Mass-agent's archive boundary finished without the earlier
timeout. The campaign still received zero credit because that cached-only task
had zero live queries; see the separate selection-contract case. Full compatible
ten-slice acceptance remains pending.

This removes duplicated shared-only assumptions rather than adding a separate
dedicated runner or relaxing its provider fence.

## Human feedback

Fix infrastructure only; do not change the harness to manufacture passing task
outcomes. Preserve the temporary five-minute task backstop, thirty-minute E2E
cutoff, successful-query evidence and exact teardown. Cement regressions and
document usable CLI settings for future runners.

## Reusable lesson

Derive every pool resource comparison from the configured CPU preset and verify
the exact native kind, count, memory and lifecycle state before guest start.
