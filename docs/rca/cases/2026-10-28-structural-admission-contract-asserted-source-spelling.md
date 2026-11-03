---
id: 2026-10-28-structural-admission-contract-asserted-source-spelling
date: 2026-10-28
title: Structural admission contract asserted old fixed-worker source spelling
surface: harness
component: semantic-deploy-admission-contract
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: semantic-deploy-gate required max_workers=DEFAULT_MAX_WORKERS after the CLI adopted host-scaled default_max_workers
symptoms:
  - command-structural runner must use bounded default admission
  - semantic-deploy exit=1
tags:
  - deploy
  - host-admission
  - structural-contract
sources:
  - PR #1627 resumed full sweep 2026-10-28T19:57:23Z
  - commit 11ba1f13b2cefc9b6a818263ac2b7700c4af9e73
repro: bash scripts/tests/semantic-deploy-gate.test.sh
status: open
---

## Problem

The full command-structural sweep failed semantic-deploy because the runner no
longer contains the literal max_workers=DEFAULT_MAX_WORKERS. Its default CLI
now uses default_max_workers(), bounded by the same ceiling of eight and scaled
to the host. The original full-sweep failure is preserved.

## Diagnosis

The path is semantic shell contract -> source-text match -> runner CLI default
branch -> run_gates admission. The source match rejected a spelling change
instead of observing the required bounded admission behavior. The replacement
contract executes the actual module and CLI branch with controlled CPU counts,
without starting heavy suites. It checks full registry dispatch and preserves
exit statuses. It passes current code and rejects both a fixed-eight-worker
mutant on an eight-core host and a false-green failure-status mutant. The
existing real-process default-admission test also passed; mock dispatch alone
is not proof of actual process admission.

Evidence is in /var/tmp/deploy-1627/resumed-structural-rca/report.md and its
semantic-proof.log and actual-admission.log. Searches used refusal 78 provider
capacity and structural bounded admission fixture environment; the older semantic
fixture failure-evidence case is related test-contract context, not a recurrence.
The general problem class is using incidental source spelling to validate a
behavioral scheduling invariant. Golden reference is not applicable to this
ordinary test correction.

## Solution

Replace only the stale literal check with executable checks of unknown, one,
eight, fourteen and 128 CPUs; full GATES dispatch; explicit max-workers override;
and success/failure propagation. Retain the ceiling assertion and unchanged
real-process admission regression. Source application and registered full-suite
verification remain pending in this draft.

## Human feedback

The user requires host-memory admission and unchanged test guarantees; no fixed
high-memory-host scheduling requirement or gate waiver was granted.

## Reusable lesson

Test the scheduler's bounded behavior and failure propagation instead of its
source spelling.

## Integration application

Reviewed correction applied by the sole deploy source owner after the frozen interim checks ended on 2026-10-28. Original failed/interrupted receipts remain unchanged. Five unchanged owning verifications and the full final deploy gates are required before closure; status remains open until verified.
