---
id: 2026-08-25-doordash-premature-checkout-missing-cart-completeness-gate
date: 2026-08-25
title: DoorDash grocery browser reached purchase write-lock with one cart item and no harness completeness gate
surface: agents
component: spawn-browser-agent-v3-write-lock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — purchase `needs_write_approval` returns to workflow without consulting cart completeness vs multi-item manifest goal
symptoms:
  - DoorDash checkout 1 item Kodiak only grocery list
  - This is only 1 item of the grocery list why are we checking out now
  - Order Summary (1 Items) Place Order write lock approval
  - 28 items in cart Shop your list misread empty Safeway cart
  - spawn_browser_agent purchase approval single Kodiak mix
tags:
  - doordash
  - grocery
  - checkout-premature
  - write-lock
  - cart-completeness
  - spawn-browser-agent
sources:
  - agent c27b4f28-994b-467f-afc6-b4082d0155c1
repro: cd agents && python scripts/run_blackbox_tests.py spawn_browser_agent_v3 — handler_cart_completeness_before_purchase_write_lock fails; cart_completeness_detects_incomplete_grocery_cart passes
status: open
---

## Problem

On Aman's DoorDash weekly grocery run (`c27b4f28-994b-467f-afc6-b4082d0155c1`,
2026-08-22), the browser agent assembled a cart with **one** Kodiak mix item,
clicked **Place Order $15.90**, and requested purchase approval. Aman rejected:
"This is only 1 item of the grocery list why are we checking out now?" Upstream
planner output and the browser `task_started` goal both listed the full Safeway
manifest (15+ line items) and said to complete checkout for the whole list.

## Diagnosis

**Critical path:** manifest + browser goal → browser LLM loop → cart assembly →
purchase click → `needs_write_approval` → user rejection.

**Runtime evidence (prod API `/api/agents/c27b4f28-…`, user `5824c58c-…`):**

| Time (UTC) | Cart / UI state |
|------------|-----------------|
| 19:40:48 | Safeway evaluate: **0 items in cart** |
| 19:41:33 | Clicked **"28 items in ca"** — DoorDash header **Shop your list** badge, not store cart |
| 19:41:46 | Grocery hub body still shows misleading **28 items in cart** label |
| 19:43–19:45 | Empty checkout/cart URLs (`order_cart_id=63c2fca2…`) |
| 19:46:51 | **Shop your list** bulk paste (partial) — did not populate cart |
| 19:50:33 | Search Kodiak; **0 in cart** → **1 items in cart** after add |
| 19:51:29 | Clicked **Checkout** with 1 item |
| 19:53:28 | Evaluate/checkout shows **Order Summary (1 Items)**; clicked **Place Order $15.90** |
| 19:55:56 | `write_lock_rejected` after user feedback |

**Upstream inputs were correct:** explore + manifest tasks produced a full checkout-ready
table; browser goal enumerated every required ingredient and said "Complete checkout,
do not stop at cart."

**First-bad boundary:** `handler.py` purchase write-lock path (`result.status ==
needs_write_approval`, `approval_type=purchase`) proceeds to
`generate_write_lock_notification` and user approval with **no harness check** that
observed cart item count is plausibly complete for a multi-item manifest goal. The
write-lock detector (`service_actions._click_write_lock_result` / `is_purchase_button`)
only matches button text — it cannot know cart completeness.

**Contributing factors (not independent root causes):**

1. **UI misread:** agent treated DoorDash "Shop your list (28 items)" chrome as a
   populated Safeway cart (~9 min wasted on empty stale cart URLs).
2. **Model execution:** after bulk-list failure, agent added only Kodiak and advanced
   checkout despite goal requiring the full manifest.
3. **Goal pressure:** "Complete checkout, do not stop at cart" without a harness
   counterweight when cart is nearly empty.

**Classification:** `our-bug` at the harness boundary (missing completeness gate);
model-intelligence contributed to the bad trajectory but is not the fixable
first-bad boundary for preventing premature purchase approval.

**Archive searches:** `checkout one item grocery manifest write lock` → relative to
chip case (same agent); `28 items in cart DoorDash premature checkout` → DoorDash
contract/evaluator relatives, not recurrence. **Novel** at the cart-completeness gate.

**Local repro (2026-08-25):**

```bash
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py spawn_browser_agent_v3
```

- `cart_completeness_detects_incomplete_grocery_cart` — **PASS** (pure detection:
  1-item cart + multi-item manifest → `should_block_purchase_for_incomplete_cart` True)
- `handler_cart_completeness_before_purchase_write_lock` — **FAIL** (handler lacks gate)

Pre-fix failure output:

```
AssertionError: handler.py returns needs_write_approval for purchase clicks without
consulting cart_completeness (c27b4f28: 1-item Kodiak checkout reached write-lock approval)
```

## Solution

**Proposed (not shipped — awaiting approval):**

1. Wire `cart_completeness.should_block_purchase_for_incomplete_cart` into
   `handler.py` immediately before purchase `needs_write_approval` returns to the
   workflow. When blocked, return a supervisor-recovery result instructing the agent
   to keep adding manifest items (do not request approval).
2. Parse observed cart counts from recent `evaluate` / checkout DOM text (`N items in cart`,
   `Order Summary (N Items)`).
3. Estimate manifest minimum from `task_prompt` (`MANIFEST:` semicolon lists).
4. Threshold: block when observed &lt; max(3, 50% of manifest lines) for multi-item
   grocery goals only (avoid breaking single-item purchase benchmarks).
5. Optional prompt addition: distinguish DoorDash **Shop your list** saved-list UI from
   actual cart badge counts.

**10k-agent behavior:** O(1) string scan on `task_prompt` plus recent browser text per
purchase write-lock candidate; no new fan-in, subscriptions, or per-user globals.

## Human feedback

- **2026-08-25:** User confirmed Fix 1 (chip after `write_lock_rejected`) must remain
  on `main`; requested formal `/rca` for Fix 2 only before implementation.

## Reusable lesson

Before returning purchase `needs_write_approval` on multi-item grocery goals, compare
observed cart counts to the manifest goal — button-text write locks cannot infer completeness.
