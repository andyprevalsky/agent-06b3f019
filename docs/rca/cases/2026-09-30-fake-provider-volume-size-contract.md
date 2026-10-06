---
id: 2026-09-30-fake-provider-volume-size-contract
date: 2026-09-30
title: Lifecycle fixture omitted volume sizes and failed before its stop-retention scenario
surface: harness
component: cloud-controller-provider-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh reset_fake_state, fake clone, and add_fake_machine wrote incomplete provider volume inventories
symptoms:
  - "pooled volume size is missing or inconsistent"
  - "cleanup discarded the claim even though stop never verified"
tags:
  - cloud-fleet
  - pool
  - volume
  - fixture
sources:
  - PR #1299
  - commit f10d13fdb42507028fcab0a1550f06ea474bd37b
repro: scripts/tests/cloudbench-fake-volume-contract.test.py
status: fixed
---

## Problem

The mandatory native Linux multi-workstream gate passed scenarios 1 through 8,
then failed scenario 9 after 1103.12 seconds with the claim-retention assertion.
The original private controller log instead showed the first refusal during
worker snapshot preflight: `pooled volume size is missing or inconsistent`.
No claim, Machine start, or cleanup stop was reached in that scenario. The
assertion alone therefore did not demonstrate discarded ownership.

## Diagnosis

The real snapshot guard requires a positive provider volume size matching the
Machine's single mounted volume. All three fake volume constructors omitted
`size_gb`; the added-Machine helper also omitted its mount size. Reset and clone
mounts already advertised 40 GB. Scenario 9 was the first normal admission using
the borrowed pool inventory after earlier recovery scenarios.

Archive searches used `cleanup discarded claim stop never verified`, `borrowed
pool failed stop ownership claim removed`, `pooled volume size is missing or
inconsistent`, and `fake volume inventory missing size_gb snapshot preflight`.
The dead-claim and warm-source cases are relatives at different boundaries;
neither establishes this fixture defect.

The owning unchanged command is
`python3 scripts/tests/cloudbench-fake-volume-contract.test.py`. It executes the
actual reset, clone, and added-Machine fixture writers and the real snapshot CLI.
With original fixture input, the exact final test fails with the missing-size
refusal. With corrected input, it passes all writer paths and rejects missing
volume size, missing mount size, and mismatched size. Its SHA256 is
`24c235797731eb96fddd16c78306b62d7d27a78c92931f308e822d4bd7eb08d1`
for both runs. Independent review repeated that same pair and checked the real
helper was unchanged.

## Solution

Publish consistent 40 GB sizes in both fixture inventory representations. Register
the real-preflight contract unconditionally in the owning lifecycle suite so
invalid provider fixtures fail immediately, before expensive controller scenarios.
Production admission, resource ownership, timeouts, evaluation, and every
existing scenario 9 assertion remain unchanged. This prevents the same preclaim
failure in the warm source, primary clone, worker clone, and added-Machine paths;
it adds no production work at 10,000 agents.

The focused regression, shell syntax checks, independent review, and full
mandatory native Linux suite passed. The unchanged suite completed in 1233.56
seconds on `05a722cc77a232b4699d92bc6542df7966ff5fd6`, including actual stop
attempts and retained claim/volume/incomplete-audit assertions. Its SHA256 is
`c38abb956827a961349f090e87d2ea30fcd30fff2dd7bd7f6fa02fa93c4bcb9d`.
These fixture outcomes supply no fleet acceptance credit and do not close the
separate live browser-injection OOM case.

## Human feedback

The user requires the full ten-slice fleet proof and rejects redefining completion
around partial results. Preserve all lifecycle and durable-evidence gates.

## Reusable lesson

Admit actual provider fixtures through the real preflight before interpreting downstream ownership assertions.
