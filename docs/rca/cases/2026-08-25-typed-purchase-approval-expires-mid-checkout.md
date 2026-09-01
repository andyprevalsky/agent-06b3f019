---
id: 2026-08-25-typed-purchase-approval-expires-mid-checkout
date: 2026-08-25
title: User-granted purchase write-lock expired after 120s so Amazon Buy Now re-prompted in the same browser task
surface: agents
component: spawn-browser-agent-v3-write-lock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py write-lock grant recording — typed purchase approvals stored without session-persistent site unlock (unlike payment-card grants via grant_site_write_lock_approvals)
symptoms:
  - Clicking <input name="submit.buy-now">
  - write_lock_granted
  - WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS
  - Rose wants to buy one unit of THORNE Creatine
  - two approval requests when it should have been 1
tags:
  - write-lock
  - purchase-approval
  - amazon
  - browser-agent
  - timeout
  - site-unlock
sources:
  - agent 2c475824-4bd6-48d2-85f8-239f024af808
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_user_granted_purchase_survives_past_timeout_like_2c475824
status: fixed
---

## Problem

Agent `2c475824-4bd6-48d2-85f8-239f024af808` (goal: buy creatine on Amazon with
saved payment) produced multiple purchase write-lock approvals for the same
THORNE Creatine buy in one browser task (`743607b0-693a-43b3-beaf-9382be6d85b5`,
same Kernel live session):

1. `cmt8828vl0bvicpvutdncl9pa` at 05:26:09 — Buy Now on product URL; user Approved.
2. `cmt888xva0bz0cpvued8uju84` at 05:31:21 — Buy Now again after sign-in + address
   edits (~312s later); user Approved.
3. `cmt89g6440c8ucpvuobcpdzx5` at 06:04:58 — purchase write-lock on checkout SPC
   URL (~2017s after #2); pending when diagnosed.

User reported two approvals when there should have been one. Measured
`write_lock_granted` → second Buy Now click = **273.518s**.

## Diagnosis

Critical path: Buy Now click → write lock (`purchase`) → user approval →
handler records typed entry without `persistent` / without
`grant_site_write_lock_approvals` → resume executes pending Buy Now → Amazon
auth + address friction → second Buy Now → `is_approval_valid` false after
120s → second approval (repeat on checkout).

Proof:

- Same `task_id` and live-view session across all three prompts (not a fresh spawn).
- Both Buy Now URLs normalize to domain `amazon.com` via `get_domain_from_url`
  (domain-mismatch ruled out).
- Pending action after first grant ran (next UI was Amazon password / sign-in,
  not a lost resume).
- `WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS = 120`; local repro of the handler-shaped
  entry aged 273.518s returns `is_approval_valid(...) is False`.
- Payment-card path already grants session-persistent site unlock
  (`grant_site_write_lock_approvals` + `test_payment_site_unlock_survives_write_lock_timeout`)
  because checkout routinely exceeds 120s; Amazon saved-payment Buy Now never
  mints a card, so it never receives that unlock.

Deepest owned cause: harness contracts disagree — payment approval unlocks the
merchant for the activity; typed purchase approval is a 120s one-off — even
though both gate the same irreversible purchase intent and real Amazon flows
exceed 120s between first grant and later purchase clicks.

Archive: novel instance; relative to payment site-unlock persistence (H-06), not
a recurrence of a prior duplicate-approval case. Searches:
`duplicate approval`, `purchase approval expired`, `typed write-lock timeout`,
`write permission cleared`, `Buy Now write lock again`.

## Solution

Landed: `apply_user_write_lock_grant` in
`agents/domains/spawn_browser_agent_v3/service_actions.py` records the typed
entry and, for `purchase` (or when payment refs / site unlock already exist),
calls `grant_site_write_lock_approvals`. The write-lock resume path in
`handler.py` uses that helper. `email_send` / `social_post` stay on the 120s
one-off timeout. `WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS` is unchanged.

Sibling prevented: checkout Place-order re-prompt after the same purchase grant
in the same browser activity (third attention on agent 2c475824).

10k-agent: O(1) dict write on existing resume-state; no new fan-in.

## Human feedback

User reported agent `2c475824-4bd6-48d2-85f8-239f024af808` had 2 approval
requests when it should have been 1, asked for `/rca`, then approved
`rca-2c475824-purchase-site-unlock` and `/deploy`.

## Reusable lesson

When a user grants a purchase write-lock without a minted payment card, unlock
the merchant for the rest of that browser activity the same way payment-card
approval already does — never rely on the 120s typed timeout across auth/address friction.
