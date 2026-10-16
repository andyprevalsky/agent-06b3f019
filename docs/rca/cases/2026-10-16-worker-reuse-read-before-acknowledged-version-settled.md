---
id: 2026-10-16-worker-reuse-read-before-acknowledged-version-settled
date: 2026-10-16
title: Worker reuse verified the old replacing instance immediately after accepting a new version
surface: infra
component: retained-agent-machine
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/retained_agent_machine.py reuse discarded the update acknowledgement and verified an immediate GET without waiting for its new instance version
symptoms:
  - Native update did not preserve the expected worker configuration
  - PREPARING retained after the update returned the correct new instance
  - Immediate GET returned the old instance in replacing state
  - Later GET matched the intended configuration and active job marker
tags:
  - fly
  - cutover
  - native-version
  - read-after-write
sources:
  - PR #1527
  - commit 1577af0fdec6db02bb26aa05ba99596e66e99eff
repro: scripts/tests/retained-agent-machine.test.py
status: fixed
---

## Problem

The first reusable-bank rollout stopped twice in `PREPARING` at the strict
configuration verifier. The old production queue and nine original workers
remained unchanged. Later exact reads matched each requested configuration,
but those reads could not explain what the verifier had received.

## Diagnosis

A single controlled diagnostic used the same durable job, global lease,
per-Machine lease and `NativePool.prepare(start=False)` on one remaining
reserved Machine. It preserved the unchanged request and raw response before
returning them to the production helper. No worker was started and no pointer
was published.

The update response was HTTP 200 with the new instance version, the exact
requested configuration and the correct active-job marker. The immediately
following HTTP 200 GET, approximately 254 milliseconds later, returned the
old instance version, its old configuration and reservation marker, and state
`replacing`. The unchanged helper consequently raised its configuration error.
A subsequent version-scoped native wait returned `ok: true` and the expected
version in `stopped`; the next GET matched that version and configuration.

Critical path: leased configuration POST -> acknowledged new version ->
unversioned GET of the still-replacing old instance -> strict mismatch ->
retained failed job. The first bad owned boundary discarded the acknowledged
version and assumed that acceptance implied an immediately current GET.

Archive searches `Machine update immediate GET config` and `native metadata
read after write propagation` found the relative
`2026-10-02-fly-cutover-start-refused-while-machine-replacing`. That case covered
a premature start, while this incident fails before start at configuration
verification. Neither the older case nor the later matching reads were treated
as causal proof; the captured POST/GET pair established this instance.

## Solution

The repair validates the acknowledged Machine ID, configuration and
job marker, waits for that exact instance version through the native stopped
state endpoint, and then requires the final GET to match the version, state,
configuration and marker. It makes no second update request and does not
relax the verifier. Lost-acknowledgement recovery retains the existing saved
job and exact configuration checks.

The native wait uses a ten-second server bound within the existing thirty-second
HTTP transport deadline. A refusal, timeout or mismatched final version remains
a failure; old workers and the current queue are preserved. The same captured-order regression failed on the original helper and passed
with this change. All 25 owning tests pass, including the original 23 cases and
invalid acknowledgement, wait, final-version and configuration controls. The
original assertion ASTs and same-attempt lost-acknowledgement recovery remain
intact. Production rollout verification remains a separate required gate.

Reference searches in `openclaw/`, `hermes-agent/`, `codex/` and
`claude-code-src/` found no Fly Machines lifecycle analogue. The provider-owned
contract is the appropriate reference: [Fly Machines API](https://fly.io/docs/machines/api/machines-resource/)
documents waiting for a stopped Machine using its instance ID.

## Human feedback

The user asked for reusable workers and safe concurrent deployment ownership,
and authorized reallocating up to one hundred benchmark Machines. No timeout
increase, weakened configuration check or new deployment identity was requested.

## Reusable lesson

Bind native read-after-write verification to the acknowledged resource version
and wait for its lifecycle transition before comparing the final snapshot.
