---
id: 2026-08-10-eventim-challenge-recovery-error-fails-no-tool-failures
date: 2026-08-10
title: Eventim no_tool_failures failed on intermediate browser_challenge_recovery ERROR after payment
surface: harness
component: long-horizon-evaluators
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/long_horizon.py::_tool_runtime_failures — treated every spawn_browser_agent toolStatus=ERROR as terminal
symptoms:
  - 'Declared evaluator eventim-1015-runtime-contract failed: Observed tool failure'
  - 'spawn_browser_agent provider-exit-recovery'
  - 'Promoted steel_managed passed candidate probes but the live tab is still challenged'
  - 'action_type=browser_challenge_recovery'
tags:
  - browser-agent
  - eventim
  - challenge-recovery
  - no-tool-failures
  - harness
sources:
  - agent 0a9eeef6-bd96-4dfc-b52b-007451fd059c
  - commit 752551a91efb1dc37b3272ee35030fb4c5e51be6
repro: agents/benchmarks — test_no_tool_failures_ignores_intermediate_challenge_recovery_errors
status: fixed
---

## Problem

Local `browser-1015-eventim-request-card` agent
`0a9eeef6-bd96-4dfc-b52b-007451fd059c` reached a grounded Eventim
`payment_approval` (`approvals_triggered=1`, receipt validated) and still
failed:

`Declared evaluator eventim-1015-runtime-contract failed: Observed tool failure:
spawn_browser_agent provider-exit-recovery-… status=ERROR`

Runtime evidence from
`agents/benchmarks/runs/20260810_064820_browser-1015-eventim-request-card.json`:

- TOOL ERROR row: `action_type=browser_challenge_recovery`,
  `toolCallId=provider-exit-recovery-25b95b85-…`,
  text `Promoted steel_managed passed candidate probes but the live tab is still challenged`
- Later TOOL FINISHED: `action_type=request_payment_card`,
  `Payment card requested ($25.05)`
- Realtime attention: merchant `Eventim US (1015 Folsom)`,
  product `wl.eventim.us/event/black-house-radio/…`, total `$25.05`
- `_validate_payment_receipt` returns `None` on that attention payload

## Diagnosis

`_tool_runtime_failures` treated every `toolStatus=ERROR` under
`spawn_browser_agent` as a terminal tool failure. Staged antibot
`recover_from_challenge` intentionally emits ERROR rows when a promoted
browser is still challenged, then the agent continues. Eventim's
`no_tool_failures` static check therefore failed closed on expected recovery
noise after a successful payment boundary.

Owning boundary: harness evaluator false negative on antibot recovery protocol
(logical inconsistency between challenge-recovery ERROR lifecycle and
`no_tool_failures`).

## Solution

Ignore intermediate `browser_challenge_recovery` /
`provider-exit-recovery-*` failures in `_tool_runtime_failures` and
`_browser_agent_runtime_facts`. Cemented by
`test_no_tool_failures_ignores_intermediate_challenge_recovery_errors`.

## Human feedback

None recorded.

## Reusable lesson

Do not treat intermediate `browser_challenge_recovery` / `provider-exit-recovery-*` ERROR rows as terminal `no_tool_failures` when the agent later reaches a grounded payment boundary.
