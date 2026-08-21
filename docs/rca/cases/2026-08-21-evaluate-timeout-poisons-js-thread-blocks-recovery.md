---
id: 2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery
date: 2026-08-21
title: Timed-out page.evaluate poisons the page JS thread so soft supervisor recovery cannot resume the browser loop
surface: agents
component: spawn-browser-agent-v3-evaluate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — asyncio.wait_for around execute_action(evaluate) times out at BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS, then _recover_browser_step(reload_page=False) only bring_to_front/Escape/dismiss; the underlying Playwright page.evaluate keeps the renderer JS thread busy so later CDP/state calls hang for another full timeout
symptoms:
  - action_timeout_evaluate_330s
  - Browser action 'evaluate' timed out after 330s; generic browser supervisor recovery ran.
  - Action evaluate failed
  - Expected one of ['payment_approval', 'auth_assistance'] attention requests (to ignore) but none was triggered
  - Timeout after 903s (dynamic cap=900s)
tags:
  - browser
  - evaluate
  - playwright
  - supervisor-recovery
  - alchemy
  - momence
  - canvas-signature
  - timeout
sources:
  - agent 01dce6e9-1f2c-4039-90dc-901ed48ce2bf
repro: none-recorded — owning-boundary Playwright repro exists as /opt/cursor/artifacts/alchemy_evaluate_hang_repro.txt (soft recovery TIMEOUT; new page OK); not yet cemented in agents/tests/blackbox/
status: open
---

## Problem

`scripts/run-bench --local browser-alchemy-springs-sauna` (k=1 on the auth_assistance
contract branch) timed out at ~909s with no `payment_approval` or `auth_assistance`.

Runtime evidence for agent `01dce6e9-1f2c-4039-90dc-901ed48ce2bf`:

- Reached Momence Morning Sauna Sundays waiver with a signature canvas and disabled
  Accept (`browser_use_step_24` page state).
- `browser_use_step_23` `evaluate` returned quickly (`signed canvas`).
- `browser_use_step_24` called `evaluate` again to stroke the canvas; worker logged
  `action_timeout_evaluate_330s` at 19:16:30 and `Action evaluate failed`.
- No further `browser_use_step_*` LLM calls until harness PAUSE at 19:22:35 (~6 min
  silence ≈ another 330s supervisor budget).
- Spawn finished `last_status=ERROR`; root paused; bench failure:
  `Expected one of ['payment_approval', 'auth_assistance'] attention requests (to ignore) but none was triggered`.

Latency: `spawn_browser_agent_activity_v3` 908.3s (1.7× historical p95).

## Diagnosis

Critical path: root `spawn_agent` → browser activity → LLM `evaluate` →
`page.evaluate` → supervisor `wait_for` → soft recovery → next state/CDP → stall →
task timeout (no attention).

First-bad boundary: after a hung `page.evaluate`, soft recovery does not reclaim a
usable JS execution context.

Local Playwright repro (same mechanism):

1. `asyncio.wait_for(page.evaluate('() => { while(true){} }'), timeout=1.5)` → TimeoutError.
2. Soft recovery (`bring_to_front` only) then `page.evaluate('1+1')` → also TimeoutError.
3. Hard recovery (`browser.new_page()` + fresh content) then `evaluate('1+1')` → `2`.

So the outer `wait_for` cancels only the Python await; the page JS thread stays
poisoned. Soft `_perform_generic_browser_recovery(..., reload_page=False)` matches
that insufficient recovery. The Momence hang itself may be page-specific (signature
pad after step 23), but the owned defect is that evaluate-timeout recovery assumes
the page remains interactive.

Archive: novel for `action_timeout_evaluate_330s`. Relative to the handler comment
that EventBus caps are non-cancellable from outer `wait_for` — evaluate has the same
class of poison. Not a recurrence of FCaptcha canvasHash.

Step 5a: our-bug / logical inconsistency in harness contracts (timeout path claims
recovery while leaving the page unusable). Not model-only: model chose a second
evaluate, but the harness then burned the remaining budget without resuming.

## Solution

Proposed (not implemented — awaiting approval):

1. On `action_timeout_evaluate_*` (and likely any evaluate timeout), escalate recovery
   beyond bring_to_front: reload or recreate the page/target so CDP can run again.
2. Cement a blackbox at `agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py`
   asserting: hung evaluate → soft recovery → subsequent evaluate still fails;
   hard recovery → subsequent evaluate succeeds.
3. Re-run exact `scripts/run-bench --local browser-alchemy-springs-sauna` for outcome
   proof (still required; proxy repro alone is not enough).

Do not raise the 900s task timeout or the 330s action supervisor timeout to "fix" this.

10k-agent behavior: per stuck page, one hard recovery instead of a second full
timeout burn; no new shared fan-in.

## Human feedback

None recorded. User asked for `/rca` after k=1 timeout; previously asked to allow
`auth_assistance` on this bench (orthogonal contract change already on the branch).

## Reusable lesson

When `page.evaluate` times out under `asyncio.wait_for`, treat soft bring_to_front
recovery as insufficient — prove the next CDP call works or recreate the page.
