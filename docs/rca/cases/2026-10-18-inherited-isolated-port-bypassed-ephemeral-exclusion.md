---
id: 2026-10-18-inherited-isolated-port-bypassed-ephemeral-exclusion
date: 2026-10-18
title: Inherited isolated-stack port preference bypassed kernel ephemeral exclusion
surface: infra
component: local-benchmark-startup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_service_stack promoted inherited CONDUCTOR_PORT plus 200 into an explicit allocator preference before automatic ephemeral exclusion
symptoms:
  - AgentCard isolated worker health port 56202 already in use
  - Implicit environment-derived preferred range overlaps Linux ephemeral allocation
tags:
  - ports
  - isolated-stack
  - regression
sources:
  - commit 12c3f4b55e60a291ce6902b47e88fb2f1acc9307
repro: agents/tests/blackbox/benchmark.blackbox.py test_local_workspace_derived_base_skips_reported_ephemeral_window
status: fixed
---

## Problem

C14 AgentCard startup exited 1 before any funded task executed. The isolated stack selected base 56200 and worker health 56202; the worker reported Address already in use at 2026-10-18T00:13:01.459839Z. Healthy concurrent smoke and semantic lanes are separate outcomes. No retry or acceptance credit follows from this component proof.

Actual services log SHA256 4baca629497aa9fbe1a8e72fe61884c8d82179a6315b2f4852996fbab1bde908 and worker log 78f02cf408321d8b4822768e5067420ee8ce9234d51fc18fd5f56008c77554d4 are retained under the private c14-agentcard-startup-rca-v1 originals. ROOT's later native policy read reported ip_local_port_range 32768..60999, no reserved ports and no remaining TCP56202 socket. The historical offending socket/process is UNKNOWN; the evidence does not prove a kernel ephemeral client caused this particular startup failure.

## Diagnosis

The allocator already excludes the kernel ephemeral interval for automatic fallback ranges. build_service_stack derives an implicit preferred base from inherited CONDUCTOR_PORT plus 200, then sends it through the preferred-range path which intentionally preserves explicit caller-owned ports. The shared-stack environment 56000 therefore selects 56200 despite canonical isolated argv having no --base-port. Per-range flock prevents cooperating Rose launchers sharing a range; availability probing does not reserve sockets against kernel client allocation between probe and worker bind.

Archive searches for ephemeral, ip_local_port_range and 56202 found no exact prior case. The September 10 local-worker-port-arithmetic-collides-across-stacks case concerns secondary-worker arithmetic and is related, not this preference/exclusion boundary.

## Solution

The private five-line runtime candidate discards only an environment-derived preference overlapping the reported kernel ephemeral interval. Explicit --base-port behavior, nonoverlapping inherited preference, unavailable-kernel behavior and existing allocator fallback remain unchanged. No prompts, timeouts, financial rules or task assertions change.

The SAME extended registered owning callback fails baseline and passes candidate using actual build_service_stack and allocator functions; no existing assertion or callback registration was removed. Two existing neighboring callbacks pass both versions. A separate actual loopback socket counterexample uses identical kernel-selected source port 38153: after real stack availability probing, a deliberate client acquires that source port; baseline health bind fails EADDRINUSE while candidate health bind succeeds outside the ephemeral interval. This demonstrates a possible race mechanism, not historical offender attribution. Baseline exit1 has 2FAIL/2PASS; candidate exit0 has 4PASS. Independent review additionally reports seven candidate controls passing, including explicit-port, tail-overlap and unavailable-kernel cases.

Exact private commands, source/test bindings, raw logs and manifest are in c14-agentcard-derived-port-rca-01a136f6; candidate.diff SHA256 827537c67b4fcf6a29b35fb88b6952a512ddc97eb285a9f1cb757f5f7c219833. Independent review is c14-port-preference-independent-review-01a136f6. Full benchmark blackbox was not run by this worker because it includes funded effects. Component acceptance does not prove the unchanged funded AgentCard benchmark outcome. New full gates and actual funded task completion remain OPEN.

## Human feedback

The user authorized finishing deploy without further allowance questions. ROOT requested a private minimal candidate and independent review before integration; this worker made no tracked source, VM, provider or financial mutations. Original startup failure and unrelated historical financial liabilities remain unchanged.

## Reusable lesson

Preserve the distinction between an explicit caller-owned port and an inherited automatic hint at the allocator boundary. Apply automatic kernel-range exclusion before promoting an environment hint into explicit-preference semantics, and test the actual build boundary rather than the fallback allocator alone.


## Deployment disposition: explicit user test override

The user subsequently directed “just skip agent card tests.” ROOT retained
`AGENTCARD_TESTS_SKIPPED_BY_USER` for this deployment, original isolated startup
exit1 and aggregate Group4 exit1. No AgentCard PASS or all-zero Group4 result is
claimed. The five-line runtime fix and extended owning test remain PRIVATE,
accepted for follow-up and NOT integrated into source12c3 or this deployment.
No new source/full qualification is introduced solely for the skipped lane.
The historical offending socket remains UNKNOWN. Required archive, owned cleanup,
final history/source review, C3, merge, applicable production and all financial
liabilities remain unchanged; the user override is not a cleanup waiver.
Case remains OPEN follow-up until an integrated source and its required gates
actually qualify. No replacement card allocation or dashboard sign-in is needed
to replace the explicitly skipped result.

## 2026-10-19 recurrence and landed fix

The PR #1519 deploy's AgentCard lane derived 56060 + 200 = 56260 and its
isolated backend failed both supervised starts with `listen EADDRINUSE :::56260`
(22:31:54Z). No listener held the port afterwards; the holder is unknown.

`build_service_stack` now takes the derived preference through
`workspace_preferred_base`, which drops it when it overlaps the reported kernel
ephemeral range, matching the design above. An explicit `--base-port` is
unchanged. `test_local_workspace_derived_base_skips_reported_ephemeral_window`
in the agents benchmark blackbox domain fails without the helper and passes
with it.
