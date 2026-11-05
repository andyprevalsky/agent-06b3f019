---
id: 2026-10-30-codex-azure-native-priority-unrecognized
date: 2026-10-30
title: Codex Azure exec default omitted priority after backend normalized Fast
surface: harness
component: codex-code-ws-server
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: azureServiceTier in e2b-templates/codex-code/ws-server.mjs accepted fast and ultrafast but not the backend native priority value
symptoms:
  - exec default tier follows the request
  - null !== priority
  - CODEX_SPEED=priority omits the Azure service_tier override
tags:
  - codex
  - azure
  - speed
sources:
  - PR #1634
repro: e2b-templates/codex-code/app-server.test.mjs
status: open
---

## Problem

Independent integration review found a producer/consumer mismatch after the
native Codex speed path was merged. The backend maps Fast to `priority`, then
writes `CODEX_SPEED=priority`; the funded exec configuration only recognized
`fast` and `ultrafast`. The app-server's explicit turn tier was correct, but
the shared exec default omitted the requested priority override.

## Diagnosis

The path is stored Agent speed -> `codexSpeedFor` -> E2B `CODEX_SPEED` ->
`azureServiceTier` -> `fundedProviderArgs` -> native CLI default tier.
The producer mapping was correct. The first wrong value was the tier helper's
null result for the normalized `priority` input. Existing live-loopback tests
covered raw `fast`, `ultrafast` and `standard`, missing the actual backend value.

Adding `priority` to the existing funded-session test matrix reproduced the
failure without changing its assertions. From repository root:

`node --test --test-name-pattern='a priority session funded by Azure alone' e2b-templates/codex-code/app-server.test.mjs`

Before: exit 1, `exec default tier follows the request`, null versus priority,
238.067 ms. After: exit 0, one pass, 236.859 ms. Logs are retained in
`/project/rose-speed-comparison-20261028/merge-efd-preview/priority-{before,after}.log`.
The process fixture consumes actual provider arguments over loopback; it
uses fake credentials and makes no live model requests.

Archive searches `Azure priority service_tier codex` and
`native speed aliases exec` found related October 28 native-speed and funded
provider cases. Their proxy/provider selection causes differ from this native
alias mismatch; this is a new first-bad consumer boundary.

## Solution

Accept `priority` alongside the existing two fast aliases in the shared
Azure tier helper. Preserve standard/null behavior, configured Azure priority
tier, explicit model, reasoning effort, and both transport paths. The new
matrix row retains the existing assertions on model, explicit turn tier,
exec default tier, effort and emitted settings. The complete unchanged Node
program plus the new row passes 29/29, zero skips, in 8.808 seconds.

No fallback, timeout or acceptance rule was weakened. No per-agent work is
added at 10,000 agents: one constant-time comparison is performed while
building session arguments. Golden reference: not applicable (ordinary
non-approval-gated implementation correction). Full merged-source deployment
gates and real-sandbox verification remain pending; this case stays open
until those required integration checks finish.

## Human feedback

Preserve the user's requested native speed and GPT-6.1 model pins. No new
instruction or waiver was requested for this correction.

## Reusable lesson

Test each transport with the normalized value emitted by its actual producer, not only the UI's pre-normalization aliases.
