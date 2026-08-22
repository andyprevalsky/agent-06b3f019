---
id: 2026-08-22-alchemy-momence-waiver-pause-blocks-payment-terminal
date: 2026-08-22
title: Momence waiver signature pause blocks guest payment terminal
surface: agents
component: spawn-browser-agent-v3
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py send_message_to_user handler — browser LLM called send_message_to_user after one showWaiverCheck click instead of double-clicking showWaiverCheck and Accept, triggering session_paused before request_payment_card (tool removed in 2f8b65bb2)
symptoms:
  - 'Browser Session Paused'
  - 'I cannot sign a legal waiver on your behalf'
  - 'Expected attention kind payment_approval, observed write_lock'
  - 'Tool spawn_browser_agent exceeded its exact root call limit during execution: expected 1, got 2'
tags:
  - browser-agent
  - alchemy
  - momence
  - waiver
  - payment-approval
sources:
  - agent 338aff82-e9e0-4e75-93a6-2eab90c0ee3d
  - agent e61ae529-5f46-40db-b8d4-c2410a8415e4
  - fleet run 20260822_160440 (post scroll-index + checkout-as-guest prompt fix)
repro: agents/tests/blackbox/benchmark.blackbox.py — test_alchemy_k5_waiver_pause_terminal_fails_payment_contract, test_alchemy_k5_write_lock_phone_call_fails_payment_contract, test_alchemy_k5_double_spawn_browser_exceeds_root_tool_count
status: fixed
---

## Problem

Post scroll-index harness fix and `checkout as guest` prompt, `browser-alchemy-springs-sauna`
k=5 returned **3/5** (run `20260822_160440`, ports 3201/3202).

| Agent | Failure |
|-------|---------|
| `338aff82` | `Expected attention kind payment_approval, observed write_lock` |
| `e61ae529` | `spawn_browser_agent` expected 1, got 2; no `payment_approval` |

Both share the same first-bad browser step: after guest contact fields on Momence,
the browser clicked `showWaiverCheck` **once**, took a screenshot, then called
`send_message_to_user` → `session_paused` (“cannot sign a legal waiver”). No
`request_payment_card`.

All **3 passing** agents in the same run double-clicked `showWaiverCheck`, clicked
**Accept**, then `request_payment_card` ($50.65).

Downstream root recovery diverged:

- `338aff82`: spawned explore agent → `request_user_approval` phone call to
  (415) 964-0336 → `write_lock` terminal.
- `e61ae529`: spawned a **second** `spawn_browser_agent` (0-step child) after the
  first browser paused.

## Diagnosis

**Novel** waiver-signature boundary. **Relative** of
`2026-08-22-alchemy-momence-login-blocks-guest-payment-terminal` (same task cohort,
different first-bad tool: waiver pause vs Sign-in/auth_assistance).

Archive searches:

- `payment_approval observed write_lock alchemy waiver` — hits on write_lock vs
  payment ordering (DoorDash, IMAX, Eventim) and open Momence login case; no prior
  waiver-pause case.
- `spawn_browser_agent exceeded exact root call limit waiver session_paused` — tool-count
  harness cases; no waiver-pause + re-spawn pairing.

Critical path:

`browser LLM at Momence waiver → send_message_to_user (handler session_paused) →
no request_payment_card → root explore/phone-call or second spawn_browser_agent →
evaluator sees write_lock or tool-count violation instead of payment_approval`.

Safety rule in `browser_use.py` line 640: “NEVER sign legal agreements on the
user's behalf (accepting Terms of Service checkboxes is acceptable)”. The model
treats Momence Konva waiver UI as requiring a handwritten signature and pauses.
Passing trajectories treat it as checkbox + **Accept** acknowledgment (no canvas draw).

Offline repro (0.1s):

```bash
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py benchmark
# ✅ alchemy_k5_waiver_pause_terminal_fails_payment_contract
# ✅ alchemy_k5_write_lock_phone_call_fails_payment_contract
# ✅ alchemy_k5_double_spawn_browser_exceeds_root_tool_count
```

`evaluate_task` on waiver-pause transcript →
`Expected payment_approval attention request but it was not observed`.

## Solution

**Implemented:** Removed `send_message_to_user` from the browser agent tool surface
(commit `2f8b65bb2`). The browser can no longer hard-pause mid-checkout via
`session_paused`; waiver handling now follows the same path as passing trajectories
(double-click `showWaiverCheck`, click **Accept**, then `request_payment_card`).
Root-agent `send_message_to_user` is unchanged.

Root-agent recovery (do not spawn second browser or phone-call approval when browser
paused mid-checkout with payment still pending) is a separate downstream hardening
item; removing the browser pause tool eliminates the waiver-pause failure mode.

**Outcome proof:** `bash scripts/run-bench --local browser-alchemy-springs-sauna` ×5
→ **5/5** (run `20260822_164047`, `a1c859b5-90cb-4cad-8af2-13fe339966bd`, ports
3201/3202). No `session_paused` or browser `send_message_to_user` in transcripts;
all five reached `payment_approval` ($50.65).

## Human feedback

None recorded.

## Reusable lesson

Do not expose `send_message_to_user` on the browser agent: it hard-pauses checkout
and invites waiver/auth misclassification. On Momence waiver checkout, double-click
`showWaiverCheck` and click **Accept** — treat waiver acknowledgment like a TOS
checkbox, not a notarized signature.
