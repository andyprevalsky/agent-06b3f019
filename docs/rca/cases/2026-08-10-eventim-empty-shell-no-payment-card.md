---
id: 2026-08-10-eventim-empty-shell-no-payment-card
date: 2026-08-10
title: Eventim Payment Details empty shells burned budget without request_payment_card after scar removal
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_crypto.py + handler.py — empty-shell nudge/exit gate removed in b483b9d15; secondary recording.py ORB not in payment-CDN exit markers
symptoms:
  - Expected payment_approval attention request (to ignore) but none was triggered
  - Payment Details inputs:0 iframes:0 while agent debugs WhiteLabel/Stripe
  - js.stripe.com net::ERR_BLOCKED_BY_ORB (no automatic provider exit)
  - WhiteLabel API 404
tags:
  - browser-agent
  - eventim
  - payment-card
  - empty-shell
  - antibot
sources:
  - agent 5d59430b-8c5c-4b93-98ab-da7b77a46af7
  - run agents/benchmarks/runs/20260810_205819_browser-1015-eventim-request-card.json
  - descend eventim-20260810T172431Z H-02
  - prior scar removal b483b9d15
repro: PYTHONPATH=tests/blackbox:. python -c 'from tests...; see blackbox tests'
status: fixed
---

## Problem

Post–H-01 exact rerun (`5d59430b-…`) still failed with no `payment_approval`.
H-01 scoring fix was observed live (`avoidConfigKey=steel_managed` →
`kernel_isp`). The agent reached Eventim checkout with **Payment Details**
headers visible but **0 inputs/iframes**, spent ~15 minutes debugging
WhiteLabel 404 / Stripe mounts, never called `request_payment_card`, then hit
timeout / cost-limit status.

Late in the run, `js.stripe.com` failed with `net::ERR_BLOCKED_BY_ORB` without
an automatic payment-CDN provider-exit (unlike `ERR_TUNNEL_CONNECTION_FAILED`).

## Diagnosis

Critical path: checkout → empty Payment Details shells → agent debugs → no
`request_payment_card` → timeout.

Owning boundary: mid-loop empty-shell nudge + hard exit gate before
`send_message_to_user` / `attempt_completion` were removed in `b483b9d15`
("remove Eventim payment-card scar coaching"). That class of failure recurred
on `5d59430b` (same as archive cases on
`2026-08-05-eventim-cloudflare-recovery-exhaustion-false-stable` items 16/18).

Secondary: `_is_payment_cdn_tunnel_failure` omitted `err_blocked_by_orb`, and
empty `document_url` on CDP loading-failed events skipped rotation.

## Solution

1. Restore **mechanism-level** empty-shell detection + mid-loop nudge + exit
   gates **without** Eventim merchant-format overfit strings (`1015 Folsom
   (Eventim - …)` examples removed from nudge/error copy).
2. Treat `ERR_BLOCKED_BY_ORB` as a payment-CDN provider-exit signal; allow
   rotation when `document_url` is missing.

## Local proof

```bash
cd agents && source venv/bin/activate
PYTHONPATH=tests/blackbox:. python - <<'PY'
# tests in spawn_browser_agent_v3.blackbox.py
PY
```

- `test_payment_card_request_nudge_fires_on_empty_payment_shells`
- `test_payment_card_required_before_exit_blocks_send_message_bypass`
- `test_payment_cdn_tunnel_failure_triggers_provider_exit_rejection` (ORB + empty document_url)

Benchmark outcome pending HARNESS_FIX_DECISION + exact rerun.

## Human feedback

(none yet — note this partially restores mechanism deleted in b483b9d15;
merchant-format examples intentionally not restored)
