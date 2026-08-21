---
id: 2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures
date: 2026-08-21
title: Alchemy no_tool_failures fails on evaluate hard-recovery ERROR after grounded payment
surface: harness
component: long-horizon-evaluators
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py::_is_intermediate_browser_retry_failure — does not classify action_type=error evaluate timeouts that ran hard renderer recovery as intermediate retry noise
symptoms:
  - 'Declared evaluator alchemy-sauna-runtime-contract failed: Observed tool failure'
  - "Browser action 'evaluate' timed out after 330s; hard renderer recovery ran after CDP classified renderer_main_thread_blocked"
  - 'spawn_browser_agent call_… status=ERROR'
  - 'action_type=error title=evaluate'
  - 'RESULTS: 0/5 passed'
tags:
  - browser-agent
  - alchemy
  - evaluate
  - hard-recovery
  - no-tool-failures
  - harness
  - momence
sources:
  - agent 1336b4b4-22e2-4212-923e-8cdfa002742b
  - agent 19a568fb-406c-45ff-bf22-fb0346a00b4b
  - agent b393b72c-e7d2-4055-b1d5-2ec245945596
  - fleet run 713f68b9-7af0-402d-b930-1c969c47bf02
repro: agents/tests/blackbox/benchmark.blackbox.py — test_no_tool_failures_ignores_intermediate_evaluate_hard_recovery_errors (proposed)
status: open
---

## Problem

`scripts/run-bench --local` alchemy pass@k=5 returned **0/5**. Two of five agents
(`1336b4b4`, `19a568fb`) reached the correct ignore-mode terminal
(`request_payment_card` → unresolved `$50.65` `payment_approval` for Morning Sauna
Sundays Aug 23 10:00 AM) after Momence Konva evaluate hung and hard recovery ran,
then failed only on:

`Declared evaluator alchemy-sauna-runtime-contract failed: Observed tool failure:
spawn_browser_agent call_… status=ERROR`

The ERROR row is `action_type=error`, title `evaluate`, text
`Browser action 'evaluate' timed out after 330s; hard renderer recovery ran after
CDP classified renderer_main_thread_blocked.` Later messages show evaluate FINISHED
again and `Payment card requested ($50.65)`.

Offline replay (0.0s wall): `_tool_runtime_failures` returns that ERROR;
`_is_intermediate_browser_retry_failure` returns False; static `no_tool_failures`
fails. A one-line classifier patch that treats hard-renderer-recovery evaluate
ERRORs as intermediate clears `_tool_runtime_failures` to `[]`.

k=1 on the same contract (`b393b72c`) PASSed without that ERROR path.

Second cohort (3/5): stopped at Momence login / `auth_assistance` before grounded
start-time selection → `alchemy-sauna-selection-semantics` fail. Separate from this
harness false-fail; keep open as agent/login-order evidence, not solved by the
`no_tool_failures` classifier fix.

## Diagnosis

Relative of `2026-08-10-eventim-challenge-recovery-error-fails-no-tool-failures`:
`_tool_runtime_failures` treats every `spawn_browser_agent` ERROR as terminal
unless classified intermediate. Challenge recovery and stale-DOM humanize ERRORs
are already ignored; evaluate hard-recovery ERRORs (added on this branch for
`renderer_main_thread_blocked`) are not.

Critical path: Momence waiver evaluate hang → hard recover → ERROR chip → agent
continues → payment_approval → harness `no_tool_failures` fails closed.

Archive searches: `alchemy-sauna-selection-semantics auth_assistance`,
`spawn_browser_agent status=ERROR`, `auth_assistance selection semantics alchemy`,
`credit_balance_exhausted`, `renderer_main_thread_blocked evaluate momence`.
Hits: Eventim no_tool_failures (relative), evaluate-timeout stall case (related
recovery path). Novel: evaluate hard-recovery ERROR not in intermediate filter.

## Solution

Proposed (not landed — awaiting approval): extend
`_is_intermediate_browser_retry_failure` to ignore browser ERROR rows whose
failure text includes hard renderer recovery /
`renderer_main_thread_blocked` / evaluate action timeout after recovery, matching
the Eventim pattern. Cement with
`test_no_tool_failures_ignores_intermediate_evaluate_hard_recovery_errors`.
Outcome proof: re-run exact alchemy bench; agents that hit recovery then payment
must not fail runtime-contract on that ERROR alone.

Do not relax selection/terminal judges or bump timeouts.

## Human feedback

User asked for `/rca` after k=1 PASS then k=5 0/5. Earlier: payment-card request
is the right terminal; `spawn_agent` expected-count was wrong (fixed to
`spawn_browser_agent`). Do not treat theories as done; need repro.

## Reusable lesson

Treat intentional browser-supervisor evaluate hard-recovery ERROR chips as
intermediate retry noise in `no_tool_failures`, the same way challenge-recovery
ERRORs are ignored when the agent later reaches a grounded payment boundary.
