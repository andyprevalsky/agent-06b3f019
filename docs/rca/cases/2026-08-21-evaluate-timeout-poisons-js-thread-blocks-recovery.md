---
id: 2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery
date: 2026-08-21
title: Renderer CDP freeze during browser actions burns soft recovery and the remaining browser budget
surface: agents
component: spawn-browser-agent-v3-action-timeout
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py:8131-8159 — TimeoutError after execute_action only runs classify_evaluate_cdp_stall + _hard_recover_frozen_renderer_page when action_name == "evaluate"; click (and other) timeouts only soft bring_to_front while the Konva renderer stays frozen
symptoms:
  - action_timeout_click_330s
  - Browser action 'click' timed out after 330s; generic browser supervisor recovery ran.
  - Recovery actions: bring_to_front
  - Expected payment_approval attention request (to ignore) but none was triggered
  - Timeout after 903s (dynamic cap=900s)
tags:
  - browser
  - evaluate
  - click
  - cdp
  - konva
  - supervisor-recovery
  - alchemy
  - momence
  - canvas-signature
  - timeout
  - reproduced
sources:
  - agent 01dce6e9-1f2c-4039-90dc-901ed48ce2bf
  - agent f666bc05-27bb-4c77-81bf-8048a232741a
  - agent 958687b8-a755-4ae6-bdbf-39e28c3b9eb5
  - agent 4161ece1-7b66-4d67-9faf-c03e4f097923
  - agent afe8a612-6f21-4eb2-af17-38bae6b5f1a9
repro: agents/tests/e2e/alchemy_evaluate_stall_repro.py + /opt/cursor/artifacts/alchemy_click_timeout_gate_repro.py + click soft-vs-hard Playwright mechanism; live k=1 20260822_011105
status: open
---

## Problem

`scripts/run-bench --local browser-alchemy-springs-sauna` hangs on the Momence
waiver / signature surface when the Chromium **renderer main thread** freezes
(react-konva). Soft supervisor recovery (`bring_to_front` only) cannot reclaim
the page; the run burns the ~900s task budget with no `payment_approval`.

Originally observed on `evaluate` timeouts. Recurrence on 2026-08-22 k=1
(`afe8a612`) hung on **`click`** instead: same soft-only recovery, same burn.

## Reproduction (not transient)

Four independent local Kernel runs (2026-08-21) — evaluate stall **reliable**:

| Run | Agent | Hung payload | Outcome |
| --- | --- | --- | --- |
| 1 | `01dce6e9` | canvas MouseEvent (sha `ded456fc3328`) | timeout 903s (pre hard-recover) |
| 2 | `f666bc05` | `[role=presentation]` PointerEvent (sha `dcee4bdbb5d2`) | live classify `renderer_main_thread_blocked`; timeout 903s |
| 3 | `958687b8` | evaluate hang + hard recover | FAIL `spawn_agent` count (got past hang) |
| 4 | `4161ece1` | sha `4ec95bc7122d` + hard recover | **same stall again**; FAIL `spawn_agent` count |

**Recurrence 2026-08-22 k=1** (`afe8a612-6f21-4eb2-af17-38bae6b5f1a9`):

- 00:58:30 — `Clicked <input name="showWaiverCheck">` OK
- 00:58:34 — `Clicking <div>` (coords 644,484) on Momence skipPreview URL
- 01:04:27 — `action_timeout_click_330s`; recovery actions **`["bring_to_front"]` only**; ERROR text `generic browser supervisor recovery ran.`
- No further TOOL progress until harness timeout 903s — `Expected payment_approval … none was triggered`
- FE: https://roselabs.ai/?agent-id=afe8a612-6f21-4eb2-af17-38bae6b5f1a9
- Run JSON: `agents/benchmarks/runs/20260822_011105_browser-alchemy-springs-sauna.json`
- Last LLM call: `browser_use_step_21` → `click` index 5868

Owning-boundary repros (both executed this RCA):

1. **Handler gate** (`alchemy_click_timeout_gate_repro.py`, ~0.5s): TimeoutError
   block after `BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS` still contains
   `if action_name == "evaluate":` around `classify_evaluate_cdp_stall` → **exit 1**.
2. **Click soft-vs-hard** (~7.4s): frozen renderer → click TimeoutError → soft
   `bring_to_front` → click still TimeoutError → `_hard_recover_frozen_renderer_page`
   → click OK.

## Diagnosis

Owned defect (refined): hard recovery was wired only for **evaluate** timeouts.
Any other action (`click`, …) that hangs on the same frozen renderer takes the
generic soft path, leaves the frozen target in place, and burns the remaining
budget. Soft bring_to_front cannot reclaim `renderer_main_thread_blocked`.

Critical path: Momence waiver surface freezes renderer → `click` waits 330s →
TimeoutError → skip CDP classify (evaluate-only gate) → soft bring_to_front →
page still frozen → no payment_approval → task timeout.

Archive: recurrence of this case (prior evaluate-only fix did not hold for click).
Relative harness case `2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures`
is separate (false `no_tool_failures` after successful hard recovery).

## Solution

Proposed (awaiting approval — not implemented in this pass):

1. On **every** `execute_action` TimeoutError (not only `evaluate`), run
   `classify_evaluate_cdp_stall` (rename later if needed) and, when
   `verdict=renderer_main_thread_blocked`, soft-recover with `reload_page=True`
   then `_hard_recover_frozen_renderer_page` (same as evaluate path).
2. Cement blackbox: frozen-renderer click timeout hard-recovers; gate repro flips
   to green; keep existing evaluate hard-recover tests.
3. Outcome proof: exact `scripts/run-bench --local browser-alchemy-springs-sauna`
   must fail on buggy revision (already: afe8a612) and pass after the fix.

Do not raise task/action timeouts to "pass" this.

10k-agent: one classified hard recovery per stuck page; no shared fan-in.

## Human feedback

User: evaluate is fine; dig into stall; clean local repro. Then: determine if
transient; rerun bench to reproduce. Rerun proved **not transient**.

User (2026-08-22): Alchemy terminal is payment_approval only (not auth_assistance);
LGTM otherwise. Then run k=1 → k=5 if pass. k=1 failed → `/rca`.

## Reusable lesson

When page-target CDP hangs on a frozen renderer, classify with browser-process CDP
on **any** action timeout — not only `evaluate`. Soft bring_to_front is
insufficient for `renderer_main_thread_blocked`; close the target from the
browser process and recreate the page.
