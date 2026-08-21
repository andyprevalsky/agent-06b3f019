---
id: 2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery
date: 2026-08-21
title: Renderer CDP freeze during evaluate burns soft recovery and the remaining browser budget
surface: agents
component: spawn-browser-agent-v3-evaluate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — asyncio.wait_for around execute_action(evaluate) times out; soft recovery only bring_to_front; Escape/JS paths time out; next get_browser_state burns another ~330s
symptoms:
  - action_timeout_evaluate_330s
  - Browser evaluate timed out; CDP stall classification verdict=renderer_main_thread_blocked
  - Browser action 'evaluate' timed out after 330s
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
  - reproduced
sources:
  - agent 01dce6e9-1f2c-4039-90dc-901ed48ce2bf
  - agent f666bc05-27bb-4c77-81bf-8048a232741a
  - agent 958687b8-a755-4ae6-bdbf-39e28c3b9eb5
  - agent 4161ece1-7b66-4d67-9faf-c03e4f097923
repro: agents/tests/e2e/alchemy_evaluate_stall_repro.py + blackbox tests; live k=1 reruns 20260821_215746 / 221618 / 223059 all hit the stall
status: open
---

## Problem

`scripts/run-bench --local browser-alchemy-springs-sauna` hangs on Momence waiver
`evaluate` (`renderer_main_thread_blocked`). Pre-fix: burns ~900s with no
attention. Post hard-recover: unblocks, then fails a different static tool-count
check (`spawn_agent` expected 1, got 0) after `request_payment_card`.

## Reproduction (not transient)

Four independent local Kernel runs — stall is **reliable**, not flaky:

| Run | Agent | Hung payload | Outcome |
| --- | --- | --- | --- |
| 1 | `01dce6e9` | canvas MouseEvent (sha `ded456fc3328`) | timeout 903s (pre hard-recover) |
| 2 | `f666bc05` | `[role=presentation]` PointerEvent (sha `dcee4bdbb5d2`) | live classify `renderer_main_thread_blocked`; timeout 903s |
| 3 | `958687b8` | evaluate hang + hard recover | FAIL `spawn_agent` count (got past hang) |
| 4 | `4161ece1` | sha `4ec95bc7122d` + hard recover | **same stall again**; FAIL `spawn_agent` count |

Rerun 4 timeline (fresh 2026-08-21 ~22:18 local bench):

- 22:22:46 — `Browser evaluate starting` (code_len=440, sha `4ec95bc7122d`) on Momence skipPreview URL
- 22:28:19 — timeout + classification (`renderer_ms=2034`, `browser_ms=57`, `verdict=renderer_main_thread_blocked`)
- 22:28:51 — soft recovery `actions=["bring_to_front"]`
- 22:28:55 — hard recovery `new_context_page`, `goto_resume_url`, `close_target`, `close_playwright_page` (`recycled=true`)
- Loop resumed (typing / checkout); harness FAIL: `spawn_agent` expected 1 got 0; counts include `request_payment_card: 1`

FE (rerun 4): `http://localhost:3202/?agent-id=4161ece1-7b66-4d67-9faf-c03e4f097923`
Run JSON: `agents/benchmarks/runs/20260821_223059_browser-alchemy-springs-sauna.json`

Different JS across runs ⇒ not a single bad evaluate program. Momence waiver
signature surface (react-konva) leaves the **renderer main thread** unresponsive
to page-target CDP while the browser process stays healthy.

## Diagnosis

Owned defect: evaluate-timeout recovery assumed the page target remained
interactive. Soft bring_to_front cannot reclaim a frozen renderer; Escape/dismiss
(JS) time out; budget burns twice.

Local mechanism repro (A healthy JS OK; B preblocked renderer matches live
recovery; C awaitPromise-cancel does not poison) remains in
`agents/tests/e2e/alchemy_evaluate_stall_repro.py`.

## Solution

Implemented:

1. Evaluate start/complete fingerprints + dual CDP classification on timeout.
2. On `verdict=renderer_main_thread_blocked`: soft recovery with `reload_page=True`,
   then `_hard_recover_frozen_renderer_page` — close hung page target(s) via
   **browser-process** `Target.closeTarget`, open a new Playwright page, goto
   resume URL, nudge browser-use via `NavigateToUrlEvent`, rebind humanizer.
3. Blackbox: healthy evaluate JS, recovery signature, hard-recover restores
   evaluate.

Hard-recovery outcome proof: runs 3–4 both log hard recovery and continue past
the evaluate hang (`request_payment_card: 1`). Case stays `open` because the
task still fails the static `spawn_agent` expectation (separate from the stall);
need a clean pass or ignore-mode attention terminal under hard recovery.

Do not raise task/action timeouts to "pass" this.

10k-agent: one classified hard recovery per stuck page; no shared fan-in.

## Human feedback

User: evaluate is fine; dig into stall; clean local repro. Then: determine if
transient; rerun bench to reproduce. Rerun proved **not transient**.

## Reusable lesson

When page-target `Runtime.evaluate` hangs, classify with browser-process CDP
before soft recovery. Soft bring_to_front is insufficient for
`renderer_main_thread_blocked` — close the target from the browser process and
recreate the page.
