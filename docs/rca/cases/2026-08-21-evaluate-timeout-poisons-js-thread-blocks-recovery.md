---
id: 2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery
date: 2026-08-21
title: Renderer CDP freeze during evaluate burns soft recovery and the remaining browser budget
surface: agents
component: spawn-browser-agent-v3-evaluate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — asyncio.wait_for around execute_action(evaluate) times out at BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS, then _recover_browser_step(reload_page=False) only succeed at bring_to_front; Escape/dismiss (JS) time out; next get_browser_state burns another ~330s with no attention terminal
symptoms:
  - action_timeout_evaluate_330s
  - Browser action 'evaluate' timed out after 330s; generic browser supervisor recovery ran.
  - Action evaluate failed
  - Expected one of ['payment_approval', 'auth_assistance'] attention requests (to ignore) but none was triggered
  - Timeout after 903s (dynamic cap=900s)
tags:
  - browser
  - evaluate
  - cdp
  - konva
  - supervisor-recovery
  - alchemy
  - momence
  - canvas-signature
  - timeout
sources:
  - agent 01dce6e9-1f2c-4039-90dc-901ed48ce2bf
repro: agents/tests/e2e/alchemy_evaluate_stall_repro.py + blackbox tests alchemy_evaluate_js_completes_on_healthy_canvas and renderer_block_matches_evaluate_timeout_recovery_signature
status: open
---

## Problem

`scripts/run-bench --local browser-alchemy-springs-sauna` (k=1) timed out at ~909s with
no `payment_approval` or `auth_assistance`.

Agent `01dce6e9-1f2c-4039-90dc-901ed48ce2bf` timeline (worker.log):

- 19:10:30.653 — step23 `evaluate` **succeeded** in ~88ms (`signed canvas`).
- 19:10:31.848 — DOM/bbox state still worked (page interactive).
- 19:10:37.533 — step24 LLM dump; evaluate about to run (exact finite MouseEvent JS).
- 19:10:37 → 19:16:30 — **no worker logs** until `action_timeout_evaluate_330s`.
- Recovery actions: `["bring_to_front"]` only. ~22s gap after the 330s cap matches
  snapshot(5s) + Escape(8s) + dismiss(8s) all timing out under `suppress` (Escape/
  dismiss never appended). Recovery URL is `fallback_url=current_url`, **not** proof
  that Playwright `page.evaluate` for the snapshot succeeded.
- 19:16:30 → 19:22:35 — another ~365s silence until harness PAUSE (no
  `browser_state_timeout_*` log; activity cancelled mid next-step CDP).

Momence waiver signature pad is **react-konva** (`ks=` in `main.c2165e2b.js`): Stage
`onMouseDown/Move/Up` + `getStage().getPointerPosition()`, not a raw signature_pad.
Accept stays disabled until Konva point state is non-empty — so step23's PointerEvent
+ canvas `stroke()` can return `signed canvas` without enabling Accept (matches the
trajectory).

## Diagnosis

Critical path: spawn browser → step23 evaluate OK → step24 CDP
`Runtime.evaluate(awaitPromise=True)` never returns → soft recovery → next state CDP
stall → task timeout (no attention).

### What the stall was **not**

1. **Not a bad evaluate program.** Exact step23/24 JS against a healthy canvas/Konva
   Stage completes in single-digit milliseconds via the same CDP shape
   (`Runtime.evaluate` + `returnByValue` + `awaitPromise`). Artifact:
   `/opt/cursor/artifacts/alchemy_konva_evaluate_repro.json` and blackbox
   `alchemy_evaluate_js_completes_on_healthy_canvas`.
2. **Not awaitPromise-cancel poison.** Cancelling a long Promise evaluate with
   `asyncio.wait_for` leaves the same page able to `evaluate(1+1)` and step24 again
   (mechanism C in `alchemy_evaluate_stall_repro.py`).

### What matches the live recovery signature

**Renderer main thread (or equivalent) unresponsive to page-target CDP**, while the
browser process stays up:

1. Pre-block renderer (`setTimeout(() => { while(true){} }, 0)` with
   `awaitPromise:false`), then send exact step24 JS → TimeoutError.
2. Dual ping: renderer `1+1` frozen, `Browser.getVersion` OK → verdict
   `renderer_main_thread_blocked`.
3. Soft recovery: `bring_to_front` succeeds; `Escape` TimeoutError — same shape as
   prod `actions: ["bring_to_front"]`.
4. Evaluate after soft still hangs; **new page** evaluate OK.

So the owned harness defect remains: evaluate-timeout recovery assumes the page
target is still interactive. The **trigger** that pinned Momence/Kernel renderer
between step23 success and step24 completion is still unknown (not the evaluate
source text). Next live hit must emit the new stall classification log.

Archive: novel for `action_timeout_evaluate_330s`. Same non-cancellable class as
EventBus BrowserStateRequest comment in config.py. Not FCaptcha canvasHash.

Step 5a: our-bug / harness recovery contract. Not model-only: model chose a second
evaluate, but the harness burned the remaining budget without reclaiming a usable
execution context.

## Solution

Implemented (this turn):

1. Evaluate start/complete logs with `code_len` + `code_sha256_12` + timings
   (`service_actions._execute_inspection_action`).
2. On `action_timeout_evaluate_*`, run `classify_evaluate_cdp_stall` (renderer vs
   browser CDP) before soft recovery and log the verdict (`handler.py`).
3. Cemented local repro: `agents/tests/e2e/alchemy_evaluate_stall_repro.py` + blackbox
   `alchemy_evaluate_js_completes_on_healthy_canvas` and
   `renderer_block_matches_evaluate_timeout_recovery_signature`.

Proposed (not implemented — needs outcome proof on the exact bench after):

1. On evaluate timeout when verdict is `renderer_main_thread_blocked` (or Escape
   soft-recovery timeouts), escalate beyond bring_to_front: reload or recreate the
   page/target so CDP can run again.
2. Re-run exact `scripts/run-bench --local browser-alchemy-springs-sauna` for
   outcome proof.

Do not raise the 900s task timeout or the 330s action supervisor timeout to "fix" this.

10k-agent behavior: per stuck page, one classified hard recovery instead of a second
full timeout burn; no new shared fan-in.

## Human feedback

User: evaluate strategy should be fine; dig into the stall; add logs if needed; need a
CLEAN local repro (reject while(true) *as the evaluate payload* stand-in for Momence).

## Reusable lesson

When CDP `Runtime.evaluate` times out under `asyncio.wait_for`, classify renderer vs
browser process before soft recovery. Finite evaluate JS can still hang if the
renderer is already wedged — prove the payload healthy separately from the recovery
contract.
