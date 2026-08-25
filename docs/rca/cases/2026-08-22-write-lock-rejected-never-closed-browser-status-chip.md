---
id: 2026-08-22-write-lock-rejected-never-closed-browser-status-chip
date: 2026-08-22
title: write_lock_rejected never closed the live browser status chip after user rejected checkout
surface: cross
component: browser-panel-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end computeActiveBrowserPanels — TERMINAL_BROWSER_ACTION_TYPES omitted write_lock_rejected while handler ends the task on rejection without task_complete
symptoms:
  - browser chip visible after user rejected write lock approval
  - write_lock_rejected Action blocked by user chip stayed visible
  - spawn_browser_agent write_lock_rejected toolStatus FINISHED panel not hidden
  - DoorDash checkout 1 item Kodiak only approval rejected
tags:
  - browser-chip
  - write-lock-rejected
  - spawn-browser-agent
  - doordash
  - checkout-premature
sources:
  - agent c27b4f28-994b-467f-afc6-b4082d0155c1
repro: front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts — hides the panel when write_lock_rejected is tool-call-scoped without task_id
status: fixed
---

## Problem

On Aman's DoorDash grocery run (`c27b4f28-994b-467f-afc6-b4082d0155c1`, 2026-08-22),
the browser agent requested purchase approval for a single Kodiak mix item ($15.90).
Aman rejected with: "This is only 1 item of the grocery list why are we checking out now?"
The live browser **status chip** (top carousel) remained visible after rejection even
though the browser task had ended.

Separately (same run): the browser advanced to checkout with only one cart item despite
a full Safeway manifest and an explicit plan to buy the entire weekly grocery list.

## Diagnosis

### Issue 1 — chip stayed visible after rejection

**Critical path:** user rejects approval → `write_lock_rejected` FE event →
`computeActiveBrowserPanels` → status chip visibility.

**Runtime evidence (prod DB):**

- `2026-08-22T19:55:56.257Z` TOOL `spawn_browser_agent` `action_type=write_lock_rejected`
  `toolStatus=FINISHED` `title=Action blocked by user` — no `task_complete` followed.
- Init task `d398cf8a-b084-4a6b-bb86-8b05fbe36875` with `toolCallId=489d5b89-…`
  never received a task-scoped terminal message.

**First-bad boundary:** `front-end/src/features/terminal/hooks/derivations.ts`
`TERMINAL_BROWSER_ACTION_TYPES` only listed `task_complete` and `session_paused`.
`write_lock_rejected` was typed by the producer (`handler.py:9528`) in the same
Aug-19 contract pass that added `write_lock_granted`, but the consumer never treated
rejection as terminal. The handler `return`s immediately after rejection without
emitting `task_complete`, so the panel had no closing signal.

**Archive:** relative to `2026-08-19-untyped-browser-approval-events-read-as-terminal`
(same typing initiative); not a recurrence of the untyped-progress bug.

**Local repro:** `browser-panel-derivations.blackbox.ts` test with init + tool-call-scoped
`write_lock_rejected` — failed pre-fix (`panels.length === 1`), passes post-fix.

### Issue 2 — checkout with one item (deep RCA, no harness bug at approval gate)

**Critical path:** manifest + browser goal → browser LLM loop → cart assembly →
write-lock approval → user rejection.

**Runtime evidence:**

| Time | Cart state (from browser evaluate / clicks) |
|------|---------------------------------------------|
| 19:40:48 | **0 items in cart** on Safeway store page |
| 19:41:33 | Clicked button labeled **"28 items in ca"** — DoorDash **Shop your list** UI (saved list count), not cart |
| 19:41:46 | Page text still shows "28 items in cart" — misleading label from list feature |
| 19:43:47–19:45 | Agent wandered through empty checkout/cart URLs (`order_cart_id=63c2fca2…`) |
| 19:46:51 | Used **Shop your list** bulk textarea; typed partial grocery list |
| 19:50:20 | Searched Kodiak; cart button read **"0 in cart"** then **"1 items in cart"** after add |
| 19:51:29 | Clicked Checkout with **1 item** |
| 19:53:28 | Clicked **Place Order $15.90** → write-lock approval for single Kodiak item |

**Upstream inputs were correct:** task 1 produced a full checkout-ready manifest table;
browser `task_started` goal listed every required ingredient and said "Complete checkout,
do not stop at cart."

**First-bad boundary:** browser agent LLM execution loop — no code gate prevented
checkout after the first successful `add to cart`. The write-lock path fires on
Place Order / checkout clicks without validating cart completeness against the goal
or manifest.

**Contributing factors (not independent root causes):**

1. **UI misread:** agent treated DoorDash "Shop your list (28 items)" as a populated cart.
2. **No cart-completeness checkpoint:** neither browser prompt enforcement nor
   `generate_write_lock_notification` validates item count vs manifest before approval.
3. **Model execution error:** after failed bulk-list flow, agent added only Kodiak and
   treated one successful add as "ready to checkout" despite goal requiring full manifest.

**Classification:** `model-intelligence-limitation` at the acting loop; not a
misconfigured manifest or verifier bug (verifier correctly scored 0% after rejection).

**There is no built-in "cart completeness checkpoint" system** the agent failed to
enforce — the agent's later explanation to Aman overstated harness responsibility.

## Solution

1. **FE:** add `write_lock_rejected` to `TERMINAL_BROWSER_ACTION_TYPES` so status chips
   hide when the user rejects a purchase approval.
2. **Producer:** stamp `task_id` on `write_lock_rejected` metadata (parity with
   `write_lock_granted`) so task-scoped transcripts also close cleanly.
3. **Tests:** two blackbox cases in `browser-panel-derivations.blackbox.ts` (task-scoped
   and tool-call-scoped rejection).

**Checkout follow-up (not shipped in this fix):** consider a write-lock preflight that
refuses approval when cart item count is below manifest minimum — separate product/harness
change; requires explicit spec (what counts as "complete" for partial availability).

**10k-agent behavior:** terminal detection is per-message O(1) on hydrated transcript
length; no new subscriptions or fan-in.

## Human feedback

User reported chip should only show while tool is in progress; asked deep RCA on
why checkout happened with one item. None recorded on fix shape.

## Reusable lesson

When a typed browser terminal event ends the task without `task_complete`, add it to
the FE terminal set — rejection events are terminals too.
