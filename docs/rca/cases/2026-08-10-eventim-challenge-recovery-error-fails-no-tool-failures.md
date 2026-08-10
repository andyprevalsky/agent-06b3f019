# Eventim challenge-recovery ERROR failed no_tool_failures after payment

## Summary

Local `browser-1015-eventim-request-card` agent
`0a9eeef6-bd96-4dfc-b52b-007451fd059c` reached a grounded Eventim
`payment_approval` (`approvals_triggered=1`, receipt validated) and still
failed:

`Declared evaluator eventim-1015-runtime-contract failed: Observed tool failure:
spawn_browser_agent provider-exit-recovery-… status=ERROR`

## Evidence

- Run: `agents/benchmarks/runs/20260810_064820_browser-1015-eventim-request-card.json`
- TOOL ERROR row: `action_type=browser_challenge_recovery`,
  `toolCallId=provider-exit-recovery-25b95b85-…`,
  text `Promoted steel_managed passed candidate probes but the live tab is still challenged`
- Later TOOL FINISHED: `action_type=request_payment_card`,
  `Payment card requested ($25.05)`
- Realtime attention: merchant `Eventim US (1015 Folsom)`,
  product `wl.eventim.us/event/black-house-radio/…`, total `$25.05`
- `_validate_payment_receipt` returns `None` on that attention payload

## Root cause

`_tool_runtime_failures` treated every `toolStatus=ERROR` under
`spawn_browser_agent` as a terminal tool failure. Staged antibot
`recover_from_challenge` intentionally emits ERROR rows when a promoted
browser is still challenged, then the agent continues. Eventim's
`no_tool_failures` static check therefore failed closed on expected recovery
noise after a successful payment boundary.

## Fix

Ignore intermediate `browser_challenge_recovery` /
`provider-exit-recovery-*` failures in `_tool_runtime_failures` and
`_browser_agent_runtime_facts`. Cemented by
`test_no_tool_failures_ignores_intermediate_challenge_recovery_errors`.

## Classification

Harness evaluator false negative on antibot recovery protocol (logical
inconsistency between challenge-recovery ERROR lifecycle and
`no_tool_failures`).
