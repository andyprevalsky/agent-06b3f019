---
id: 2026-10-26-sealed-reserve-gate-failure-lost-child-evidence
date: 2026-10-26
title: Sealed reserve structural gate failed without retained child evidence
surface: harness
component: deploy-structural-runner
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: original sealed reserve child returned nonzero; causal branch unobserved after temporary fixture deletion
symptoms:
  - test_stress200_existing_allocator_requires_sealed_minimum_plan sealed True failed
  - AssertionError False != True at run-deploy-structural-gates.test.py line841
tags:
  - structural-gate
  - sealed-cohort
  - missing-child-evidence
sources:
  - commit ff4d24295df7863a4b92f761892b4310f91aa9a6
  - plan:.context/rca-structural-sealed/findings.txt
repro: none-recorded
status: open
---

## Problem

The integrated66-command structural run failed only deploy-structural-runner.
The sealed=True child returned nonzero. Its receipt had owner_count200 and
provider_calls0, but stdout/stderr and per-owner evidence were not printed and
the TemporaryDirectory was deleted. The full52-test gate took228.590seconds;
that duration alone proves no causal load or timeout mechanism.

## Diagnosis

No causal diagnosis is established. At the same frozen source, the unchanged
owning method with pinned Python3.11.9 and the gate PATH passed51.261seconds:
200sealed owners admitted, nested canary exit0, all receipt assertions true,
and all400fixture children across sealed/unsealed controls reaped. Scratch
instrumentation retained child output and directories without changing source,
assertions or budgets. The original failing branch remains unobserved.
A separate Python3.12 diagnostic also passed but is not exact-gate evidence.

Two archive searches and the concurrent-free-space admission and repeated
registry-reconciliation cases supplied context, not a proven recurrence.
Full evidence, command arrays, source hashes and limitations are retained under
.context/rca-structural-sealed. The mandatory native red-to-green gate is unmet.

## Solution

No source fix proposed or applied. Preserve this open failure and retain child
output and the full fixture on a subsequent owning/native failure. The scratch
replay already supports that observation; the coordinating agent owns any
integrated rerun and permanent observability review. This case preserves the unresolved boundary in the shared RCA archive; passing
observations do not constitute a causal fix.

## Human feedback

The coordinating agent required frozen source, actual retained native evidence, no race
assumption, no timeout/assertion/admission weakening, and exact diff review
before source changes. The coordinating agent also requested no test
changes based only on a passing replay. Production, controllers, providers,
Freedom and other workers remain untouched; no INDEX changes were authorized.

## Reusable lesson

Retain the child exit status, output and native fixture before deleting a failed gate's temporary evidence.


## Follow-up full owning-suite observation

One scratch-retained run of the full52-test owning suite on integrated HEAD
20ba31ca2470f3a6399375a9f9c1e160dcd8b347 passed in92.990seconds under pinned
Python3.11.9. All four sealed source files remained byte-identical. The sealed
case admitted200, nested exit0, and all6assertions passed; each case reaped200
fixture children. This provides full owning-suite observation, not a cause or
fix for the original66-gate concurrent failure. No source change was made.
The original RCA remains open pending a captured native failure.

## Integrated verification

The canonical 66-suite command subsequently passed on the integrated source.
Its full owning 52-test suite passed in118.160seconds with the original sealed
assertions and deadlines. Evidence is retained in
.context/rca-6731984c/integrated-command-structural-rerun.log. This clears that
execution of the deployment gate and does not identify or repair the earlier
nonzero child outcome. The archive status remains open.
