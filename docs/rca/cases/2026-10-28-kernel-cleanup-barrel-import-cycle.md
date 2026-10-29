---
id: 2026-10-28-kernel-cleanup-barrel-import-cycle
date: 2026-10-28
title: Kernel lifecycle cleanup read its own uninitialized release re-export
surface: back-end
component: browser-session-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: sessionCleanup defaultDependencies reads Kernel barrel releaseKernelRemoteSession during Kernel module initialization
symptoms:
  - "TypeError: Cannot read properties of undefined (reading 'releaseKernelRemoteSession')"
  - "compute-connect-setup-release.test.ts failed before assertions"
  - "compute-connect-watcher-failure.test.ts and kernel-tab-reset.test.ts failed on module import"
tags:
  - kernel
  - module-cycle
  - browser-lifecycle
sources:
  - PR #1627
  - commit 11ba1f13b2cefc9b6a818263ac2b7700c4af9e73
repro: back-end/src/tests/unit/kernel-tab-reset.test.ts
status: open
---

## Problem

Current backend coverage recorded three unit failures before test assertions.
All share the exact TypeError in symptoms. Original per-test logs are preserved
under /var/tmp/deploy-1627/resumed-backend-unit-rca/original-logs.

## Diagnosis

The runtime stack reaches sessionCleanup.ts defaultDependencies:27 while
kernel.ts is still initializing. Kernel imports steel/lifecycleClaim, which
imports browser/resumeLifecycle, which imports sessionCleanup, which imports
the Kernel barrel again. Its kernelSessionDelete re-export is not ready.
Archive searches releaseKernelRemoteSession and circular import module
initialization registry found related layering guidance, not this exact cause.
Three unchanged original tests fail at the same boundary locally under the
active coverage runner environment, then pass with one direct leaf import.

## Solution

Candidate only: sessionCleanup imports the existing release function directly
from kernelSessionDelete. Two blackbox fake-release selectors follow that import
path without any assertion changes. Original release implementation, ownership,
retry policy and budgets are unchanged. No runtime fallback or lazy import.
Before exits all1, times1.737/1.371/1.407s; after exits all0,
times1.916/1.001/0.946s. Exact commands/logs in run.py and results.json under the
same temp artifact directory. Node22.23.4, installed tsx, inherited active
coverage environment, network denial and V8 output redirected temp.
All three original tests are discovered by scripts/run-unit-tests.ts under
run-coverage.sh. Browser-session blackbox registers the two fixture consumers,
but their integration checks and any new owning blackbox regression remain
pending with the parent, as do source application and full coverage. No full
coverage pass is claimed. Golden reference: not applicable (no approval-gated
behavior or prompt hunk).

## Human feedback

Parent required read-only source11ba, no provider calls, unchanged assertions
and timeouts, actual inherited coverage environment, temporary candidates only,
and parent-only source application after freeze. Initial missing-hoisted-tsx
setup failure was preserved separately, excluded from causal evidence and
corrected without installation.

## Reusable lesson

Import lifecycle primitives from their owning leaf module rather than a barrel that depends on the lifecycle consumer.

## Integration application

Reviewed correction applied by the sole deploy source owner after the frozen interim checks ended on 2026-10-28. Original failed/interrupted receipts remain unchanged. Five unchanged owning verifications and the full final deploy gates are required before closure; status remains open until verified.

## Permanent owning regression

The reviewed additive `browser-session-cold-import.cases.ts` regression now runs
from `browser-session.blackbox.ts` in the default suite and via
`--cold-import-only`. It cold-loads Kernel, connectSession and its watcher in
three separate Node processes, checks the public callable export and rejects
network attempts. Physical original11ba source plus unchanged new assertions
failed the owning focused command in1.854s; changing only the direct leaf import
passed in2.614s. The direct helper independently failed0.527s and passed1.372s.
Exact before/after artifacts and registration proof are preserved under
`/var/tmp/deploy-1627/resumed-backend-unit-rca/cold-import-regression/`.
The interim full run was interrupted through its exact owned supervisor after
an isolated connect-peer diagnostic proved the same pre-READY import error;
that interrupted run is not a coverage pass. Full final coverage remains required.
