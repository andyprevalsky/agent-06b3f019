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

## 2026-10-27 batch5 recurrence — OPEN

Source 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0. The original owning
sealed=True subtest raised subprocess.TimeoutExpired at the unchanged120s
boundary, scripts/tests/run-deploy-structural-gates.test.py:837. TemporaryDirectory
cleanup then reported errno39, sealed not empty. These are one primary owning
failure and cleanup fallout. The earlier archived incident was a normally
returned nonzero child; shared cause is not established.

The original /tmp/stress200-owning-yvxzmd09 was rescued before any new native
execution. Only nested/cleanup-disk-reserve.lock and .status survived inside
sealed/. The lock recorded PID3528326, now absent; status contained120.
Source order shows the driver had passed the200 completion handshakes and
started the nested preflight. It does not prove200 successful admissions, and
status120 is not an identified internal timeout contract. It may be fallout;
no causal inference is justified without the lost child stdout/stderr, receipt,
per-owner logs or pre-kill process observations.

No surviving process with the exact original fixture path was found. The
original temporary directory is unchanged; its metadata and file bytes were
copied to the worker's own evidence directory. No original process was signalled.

One unchanged owning-method observation under pinned3.11.9 passed in73.937s.
Unsealed:95admitted/105rejected, child exit1 expected. Sealed:200admitted,
child exit0, nested0, all assertions true. Both created/reaped200children;
no recorded child PID remained. This is a diagnostic observation, not a
causal red/green repair. A second run qualifies the opt-in capture, not a fix.

The RCA remains unresolved. No runtime or acceptance patch is proposed.
A scratch-only gated capture is prepared for the coordinator's next planned
canonical occurrence, retaining temporary state and child output with a passive
110s driver traceback before the original120s boundary. Original assertions,
200concurrency, capacity72705MiB, native deadlines and zero-provider contract
remain unchanged. Root owns archive integration, full gates and any later fix.
