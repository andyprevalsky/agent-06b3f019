---
id: 2026-09-30-unconfigured-phone-callee-admitted-cloud-capability
date: 2026-09-30
title: Cloud capability sampler admitted a phone task without its configured callee
surface: infra
component: fleet-capability-selection
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/fleet_infra_sample.py:eligible_pool admitted a phone_persona task absent from the configured BENCHMARK_CALLEE_PHONE_NUMBER_IDS mapping
symptoms:
  - "BENCHMARK_CALLEE_PHONE_NUMBER_IDS has no assignment for phone-call-ivr-dtmf"
  - "owned cloud execution has no proven root allocation"
  - "runtime evidence is incomplete; retaining original fleet volumes"
tags:
  - cloud-fleet
  - capability-proof
  - phone-callee
  - exact-ownership
sources:
  - PR #1299
  - commit 5650309fa33d4bf5fa0a1bf051c4841d6833ed4a
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: mitigated
---

## Problem

The third slice of proof72 sampled `phone-call-ivr-dtmf` among ten ready
capability tasks. Its guest raised
`BENCHMARK_CALLEE_PHONE_NUMBER_IDS has no assignment for phone-call-ivr-dtmf`
before creating a benchmark root or run result. The driver then could not
publish a clean shutdown or complete runtime evidence, so the exact owner
retained ten pool claims. The slice was INFRA, with no streak credit. Nine
other tasks had run results; none of those results can repair the missing tenth.
The authoritative local backend env and the Cloud controller backend env both
had a nonempty two-task mapping but no entry for this IVR task. Values were not
printed or committed.

## Diagnosis

The readiness path was catalog `ready` → `eligible_pool(require_cloud_root)` →
random slice → guest `phone_callee._configured_number_id_for_task`. The sampler
already excluded rootless SMS, Mac relay, and production-only tasks, but did not
validate the configured phone-callee mapping. The first wrong decision was
admission, not the guest's fail-closed rejection. The guest driver log proves
the rejection preceded root allocation; the exact recovery provider manifest
recorded zero root, browser-session, payment, and allocation events. A
zero-credit archive of all ten original volumes passed native provider
verification; the ten Machines were stopped, their claims released, and the
failed owner's registry removed. This did not turn the invalid slice valid.

Archive searches for the literal assignment error and for cloud readiness plus
retained cleanup found no earlier case at this boundary. The 2026-09-02 IVR
DTMF-tool case concerns the outbound assistant after a call starts and is a
different first-bad boundary. The problem class is fixture/environment/data
mismatch: an environment-specific task prerequisite was not checked before
paid allocation.

## Solution

`fleet_infra_sample.py` now reads the same process-env-then-backend-env mapping
used by the phone benchmark. If a mapping is configured, it excludes every
unassigned `phone_persona` task from capability sampling and rejects an
explicit pool containing one before provisioning. A configured task remains
eligible; an empty mapping retains the benchmark's existing dynamic-number
path. No benchmark prompt, evaluator, timeout, model, or scored result changed.
At 10,000 agents this adds one local env read and catalog scan per sampled
proof, with no provider requests or guest startup. `CLAUDE.md` documents the
preflight and the need to reconcile authoritative backend env before an
intentional phone-task run.

The unchanged local boundary assertion failed before the fix with
`AssertionError: unprovisioned IVR task admitted to cloud capability proof`:
`BENCHMARK_CALLEE_PHONE_NUMBER_IDS='phone-call-client-intake=fake-intake,phone-call-payment=fake-payment' python3 - ... eligible_pool(..., require_cloud_root=True)`.
It passed after the fix. The checked-in fleet proof suite also verifies that
the explicit IVR pool fails before provisioning, the default pool excludes it,
and a configured phone task remains eligible; all 25 checks passed. A live
ten-slice Cloud outcome proof is still in progress, so this case remains
mitigated until the new campaign reaches the requested consecutive streak.

## Human feedback

The user required infrastructure-only work, ten consecutive valid slices of ten,
at least three successful LLM calls per bench, exact teardown, and no harness
changes to manufacture passing benchmark scores. A benchmark `FAILED` result
is allowed; a task with no result and unverified cleanup is not.

## Reusable lesson

Before sampling a paid capability fleet, validate every task's configured
environment prerequisites at selection time and reject unready tasks before
provisioning.
