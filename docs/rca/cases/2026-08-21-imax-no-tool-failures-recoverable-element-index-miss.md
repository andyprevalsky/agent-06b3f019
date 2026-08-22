---
id: 2026-08-21-imax-no-tool-failures-recoverable-element-index-miss
date: 2026-08-21
title: no_tool_failures failed closed on a recovered stale-DOM element index miss
surface: agents
component: benchmark-static-checks
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _tool_runtime_failures / _run_declared_static_check (type=no_tool_failures) counted a recovered browser ERROR as terminal
symptoms:
  - "Observed tool failure: spawn_browser_agent"
  - "Element with index 0 not found"
  - "no_tool_failures"
tags:
  - benchmark-evaluator
  - browser-agent
  - recovery-noise
sources:
  - agent fdd449b5-2288-4890-b001-dfae973097a6
repro: agents/benchmarks/run_benchmark.py --task browser-imax-group-tickets
status: fixed
---

# RCA: `no_tool_failures` fails closed on recovered DOM index miss

## Symptom

`browser-imax-group-tickets` outcome-proof agent
`fdd449b5-2288-4890-b001-dfae973097a6` reached grounded `payment_approval`
(`request_payment_card` FINISHED, ~$95.94) after H-01, then failed only on
declared evaluator `imax-group-ticket-runtime-contract` /
`no_tool_failures`:

`Observed tool failure: spawn_browser_agent call_Zp8HUD74TFWqfl2xUnbDeHXg status=ERROR`

The ERROR row was title `Scrolled down 600px`, message
`Element with index 0 not found`, mid-run (`steps_taken=3`); the browser
continued and later requested payment.

## Classification

**Faulty Evaluator** — `no_tool_failures` counted a recovered stale-DOM index
miss as a terminal tool failure, disagreeing with the payment-terminal task
contract (`success_on_payment_card_request=true`,
`expected_attention_kind=payment_approval`) and with the existing antibot
recovery-noise exclusion in the same helper.

## First-bad boundary

`agents/benchmarks/run_benchmark.py` → `_tool_runtime_failures` /
`_run_declared_static_check` (`type=no_tool_failures`).

## Owning-boundary proof

- **Pre-fix (artifact messages):** `_tool_runtime_failures` returned
  `[spawn_browser_agent call_Zp8HUD74TFWqfl2xUnbDeHXg status=ERROR]`;
  static check `(False, Observed tool failure: ...)`.
- **Post-fix:** same artifact → `[]` / `(True, All declared static checks passed)`.
- **Cement:** `declared_static_no_tool_failures_ignores_recoverable_element_index_miss`
  + unrecovered negative control in `agents/tests/blackbox/benchmark.blackbox.py`.

## Fix

Ignore browser `Element with index N not found` ERROR rows only when a later
browser event proves recovery (FINISHED non-error action or
`request_payment_card`). Unrecovered terminal misses still fail closed.

## Follow-up (H-03)

Outcome-proof agent `00479d10-d10a-46d9-8103-631bf8586ffa` still failed
`no_tool_failures` on the same recovered index miss because live
`GET /api/agents/:id` exposes body as `text`, while H-02 only read
artifact-shaped `message`. Post-hoc on saved `logs.messages` (keyed
`message`) already passed. Fix: `_tool_message_body` reads `text` or
`message`.

## Follow-up (H-04)

Outcome agent `5bcb4a80-9c0e-4521-ab9a-a7ae0e471181` cleared tool failures after H-03,
observed payment_approval (~$95.94), then failed
`agent_status ACTIVE vs COMPLETED`. Payment-terminal contract
(`success_on_payment_card_request`, `approval_handling=ignore`) leaves the root
ACTIVE; sibling `browser-event-ticket` omits `agent_status`. Remove COMPLETED
check and align criteria/context_notes with unresolved payment-card stop.

## Problem

See `## Symptom`. Agent `fdd449b5-2288-4890-b001-dfae973097a6` reached grounded
`payment_approval` (~$95.94) and failed only `no_tool_failures`, on a mid-run
browser ERROR (`Element with index 0 not found`) that the agent recovered from.

## Diagnosis

See `## Classification`, `## First-bad boundary`, and `## Owning-boundary proof`.
`_tool_runtime_failures` / `_run_declared_static_check` counted a recovered
stale-DOM index miss as terminal, contradicting the payment-terminal task
contract and the antibot recovery-noise exclusion already present in the same
helper.

## Solution

See `## Fix`, `## Follow-up (H-03)`, and `## Follow-up (H-04)`.

## Human feedback

None recorded.

## Reusable lesson

An evaluator that counts tool ERRORs must ignore errors the agent demonstrably
recovered from, or it fails runs that met the task contract.
