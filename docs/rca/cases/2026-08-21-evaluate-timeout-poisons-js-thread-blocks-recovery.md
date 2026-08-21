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
repro: agents/tests/e2e/alchemy_evaluate_stall_repro.py + blackbox tests; live rerun 20260821_215746 reproduced with classification
status: open
---

## Problem

`scripts/run-bench --local browser-alchemy-springs-sauna` times out ~900s with no
attention terminal after an evaluate hang on the Momence waiver surface.

## Reproduction (not transient)

Two independent local Kernel runs, different evaluate payloads, same class:

| Run | Agent | Hung payload | Classification |
| --- | --- | --- | --- |
| 1 | `01dce6e9` | canvas MouseEvent stroke (sha `ded456fc3328`) | inferred from recovery shape |
| 2 | `f666bc05` | `[role=presentation]` PointerEvent fanout (sha `dcee4bdbb5d2`) | **live** `renderer=frozen browser=ok verdict=renderer_main_thread_blocked` |

Rerun 2 timeline:

- 21:46:21.125 — `Browser evaluate starting` (code_len=475, sha `dcee4bdbb5d2`)
- 21:51:53.778 — timeout + classification (`renderer_ms=2030`, `browser_ms=60`)
- 21:52:16.487 — soft recovery `actions=["bring_to_front"]` only
- Harness FAIL: Timeout 903s, no payment/auth_assistance attention

FE (rerun): `http://localhost:3202/?agent-id=f666bc05-27bb-4c77-81bf-8048a232741a`
Run JSON: `agents/benchmarks/runs/20260821_215746_browser-alchemy-springs-sauna.json`

Different JS both times ⇒ not a single bad evaluate program. Momence waiver
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

Still required for close: re-run exact
`scripts/run-bench --local browser-alchemy-springs-sauna` and show the run gets
past evaluate (attention terminal or non-timeout progress) with hard recovery
logs present. Case stays `open` until that outcome proof.

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
