---
id: 2026-10-02-payment-card-shadow-index-bypassed-semantic-fill
date: 2026-10-02
title: Stale shadow input index rejected an approved payment card before semantic fill
surface: agents
component: spawn_browser_agent_v3-input_text
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py execute_action returned on a missing selector-map index before _execute_input_text could locate the approved card field semantically
symptoms:
  - 'Element with index 8 not found'
  - 'card number is required'
  - 'Max iterations (60) reached'
tags:
  - browser-agent
  - payment-card
  - shadow-dom
  - stale-index
sources:
  - agent 0cba1515-0fca-4738-b931-eed29ee3bb9e
  - plan:.context/diagnostics/0cba1515-postfail/agent-latency.txt
  - PR #1378
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_execute_action_approved_payment_ref_recovers_from_stale_shadow_index
status: open
---

## Problem

The unchanged local `agent-payment-idempotent-abandonment` task on agent
`0cba1515-0fca-4738-b931-eed29ee3bb9e` reached the second browser checkout
with an approved card ending in 6910. Its `input_text(index=8,
text=card_number)` action returned `Element with index 8 not found` even though
the browser state displayed card inputs inside an open shadow root. The browser
then used `evaluate` to enter literal ref names. The checkout showed `card
number is required`, and that browser task exhausted 60 iterations.

The root agent later reached `COMPLETED` by spawning a recovery child, but the
evaluator observed its own purchase still `HELD` instead of the required
`CLEARED`. Cleanup later moved that purchase to `VOIDED` and wallet funding to
`RECLAIMED`; the child created a separate `CLEARED` purchase with a different
card. That cannot satisfy the root task's idempotent settlement contract.

## Diagnosis

The path is browser state with a shadow-root card field → model `input_text`
with an approved secret ref → `execute_action` index lookup →
`_execute_input_text` semantic card-field locator → merchant checkout.
`execute_action` returned immediately when `selector_map.get(8)` was empty,
before `_execute_input_text` could run its existing approved-card direct fill,
which pierces open shadow roots and frames. This was the first bad boundary.
The empty selector-map entry should only reject actions that require that
index. Archive searches for `Element with index 8 not found payment card
shadow DOM input_text` and `browser checkout literal card_number secret ref
evaluate React field required` found related browser cases, but no recurrence
at this index-before-semantic-fill boundary.

## Solution

`execute_action` now clears a stale index only when `input_text` carries a
fully approved payment-card secret ref, allowing the existing semantic locator
to fill the real value. Other missing-index actions retain their explicit
error. The owning blackbox regression failed against the original dispatcher
and passed against the fix. The full `spawn-browser-agent-v3` domain passed
(1 domain, 0 failures). The exact unchanged benchmark must still pass after a
worker restart before this case can be marked fixed.
At scale the change adds no work to ordinary actions; it activates the existing
semantic locator only for approved card refs whose index is absent.

## Human feedback

None recorded.

## Reusable lesson

Let approved secret-ref input reach its semantic field locator when a browser
state index is absent from the selector map.
