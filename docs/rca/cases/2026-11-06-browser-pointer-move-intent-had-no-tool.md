---
id: 2026-11-06-browser-pointer-move-intent-had-no-tool
date: 2026-11-06
title: Browser tool surface had no pointer-only move, so agents faked movement with drag and looped on end-only drags
surface: agents
component: browser-tools / spawn-browser-agent-v3 tool surface
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: "agents/browser_tools/schemas.py BROWSER_TOOL_MODELS + agents/providers/rose/browser_use.py BROWSER_USE_TOOLS — no hover/move tool, and click descriptions omitted the humanized pointer travel that humanizer.click_at_coords already performs"
symptoms:
  - "Your `drag` tool call was rejected because its arguments failed validation: - Value error, drag requires source_index or both start_x and start_y"
  - "Timeout after 426s (task timeout=420s) | Agent status: PAUSED (expected COMPLETED)"
  - "FCaptcha captured API risk score 0.164 exceeds ratchet 0.163"
  - "there's no pure mouse-move tool"
tags:
  - browser
  - drag
  - hover
  - biometrics
  - webdecoy
  - smoke
  - tool-surface
sources:
  - agent 98fac0b3-312f-445c-89f3-1b3e96a8a0ff (cloud, 15a310c2d, PR #1691 deploy)
  - agent 1411db97-0b18-4b9c-90d4-516982b948df (cloud, same drag loop 2026-11-04)
  - agent dc306296-2b2e-4b69-9603-e153137b7e5e (risk 0.164 after pointer-faking drag)
  - agent 8d029581-c5ca-418a-b255-69df3f729eef (risk 0.187 after 4 pointer-faking drags)
  - agent 1eeef95c-a0ae-4516-a6b5-df03a9d1fa0d (local repro on 24b862375, FAIL)
  - agent d920016a-5ad8-47d9-879b-e1206c9aff1c (local fix run on cce696e9d, PASS)
  - commit cce696e9d
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_pointer_move_intent_has_a_hover_tool_instead_of_drag
status: fixed
---

## Problem

Smoke `browser-biometrics-webdecoy` asks the browser agent to "move to and
click" FCaptcha controls like a normal user. On 15a310c2d (cloud, agent
98fac0b3) the browser sub-agent (kimi-k3, pool rose-1-oss) sent 147 identical
`drag` calls that validation rejected with "drag requires source_index or both
start_x and start_y", one every ~2 s, until "Timeout after 426s ... Agent status:
PAUSED". Agent 1411db97 (2026-11-04) shows the same loop. On 493df3405 the task
completed but scored 0.164 against the 0.163 ratchet. In the Benchmark Hub both
drag-loop timeouts and both recent ratchet failures (dc306296 0.164, 8d029581
0.187) used `drag`, and recent passing runs (2d980490, 286e26a4) used none.

The local run on main 24b862375 (`scripts/run-bench --local
browser-biometrics-webdecoy`) reproduced it exactly: 177 rejected drags from
00:51:22 to 00:57:10, then a timeout at 425 s. The browser recording's
`action_entries` show identical params every time:
`{"end_x": 480, "end_y": 408, "steps": 20}`.

## Diagnosis

1. Every failing trajectory has the model reasoning "there's no pure mouse-move
   tool ... I can use drag with small movements to simulate mouse movement"
   (98fac0b3 msg 41, 1411db97 msg 26/31, dc306296 msg 28/36, 8d029581
   msg 31/43). The task asks it to "move to" the control.
2. The runtime already moves the pointer naturally: every click path calls
   `humanizer.click_at_coords`, which synthesizes a human trajectory with
   overshoot before pressing (`agents/browser_tools/humanizer.py`).
   `humanizer.hover()` also exists. The tool descriptions said only
   "Click element by index", and no tool exposed hover. `evaluate`'s
   description even routes "hover, drag" to JavaScript, which this task
   forbids.
3. So pointer movement could only be expressed as `drag` (press, hold, release).
   Press-drags add bot-like events (higher FCaptcha risk). When the model
   wanted "move from where the pointer is to the submit button" it emitted
   `drag(end_x, end_y)`, which no drag argument set can represent. Rejection
   feedback cannot fix an intent the schema cannot express, so it repeated
   the same call until the cap.
4. Causal replay: the captured step-6 decision of 1eeef95c, replayed through
   RoseClient with recorded tools, chose drag 7/10 (click 1, scroll 2).
   Changing only the descriptions cut that to 3/10. Adding hover and the
   descriptions cut it to 2/10, which is the floor for this replay because
   its fixed history already contains the model's earlier "use drag to
   simulate movement" reasoning. In fresh runs with the fix the model calls
   `hover(index)` and then `click`, with zero drags.

Step 5a ladder: why drag? No pointer-only move (deepest owned cause). Why did
it loop? The end-only intent is unrepresentable in drag (consequence of the
same gap). Next rung, "the tool surface lacks some primitive the model wants",
is an incoherent grab-bag. Stop at a missing pointer-move capability.

Step 5b (prompt/tool-text edit): the class we stopped at is "the tool surface
cannot express a pointer-only move, an intent the runtime already supports".
The next-deeper class tried was "tool descriptions misstate runtime side
effects". On its own that fix was incoherent as the full repair: the
description-only replay still chose drag 3/10, because the intent survives
truthful text when no tool can express it. The fix therefore adds the
capability and keeps the truthful descriptions.

Golden reference: claude-code-src/cli.js:1830 `mouse_move` ("Move the mouse
cursor without clicking. Useful for triggering hover states."; drag "Press,
move to target, and release."); claude-code-src/cli.js:66 Claude in Chrome
`hover` action; openclaw/extensions/browser/src/browser-tool.schema.ts:19
`hover` act kind and openclaw/src/agents/tools/computer-tool-schema.ts:204-210
pointerAction `hover`; claude-code-src/src/utils/computerUse/executor.ts:103-120
moves the pointer before click. The fix converges: a separate pointer-move tool,
with drag as a held-button gesture.

Observability gap found on the way: `RoseClient.complete_browser_use` re-raised
`BrowserToolArgsValidationError` before `dump_llm_context`, so no rejected
browser decision was ever dumped. The cloud run kept no record of the rejected
args.

## Solution

Commit cce696e9d:
- `hover` browser tool (`HoverTool`: index or x+y), dispatched in
  `service_actions._execute_hover` to the existing `humanizer.hover()`. It
  never presses, and it is registered in normalize, `_VALID_ACTIONS`, handler
  tool-argument redaction fields, the awaiting-observation set and state
  prefetch.
- `click`/`click_coordinates` descriptions state that the pointer travels a
  natural path first. `drag` says the button stays held, that drag is never
  for moving the pointer, and that both ends are required.
- Rejected tool-arg decisions are now dumped (`tool_args_validation_error` in
  output) before the loop feeds the rejection back.
- Regressions (fail on 24b862375, pass on cce696e9d): rose_browser_use
  `pointer_move_intent_has_hover_tool`, `pointer_tool_descriptions_match_runtime`,
  `rejected browser tool args are still dumped`; spawn_browser_agent_v3
  `execute_action_hover_moves_pointer_without_pressing`. The phone-off
  byte pin was re-pinned for the tools hash only; system and message hashes
  are unchanged.

Sibling failures prevented: hover-revealed menus and tooltips no longer need
JavaScript (untrusted events). 10k agents: one extra tool definition per
browser request; hover is a per-session pointer move with no shared state.

## Human feedback

None recorded.

## Reusable lesson

When a browser model keeps faking an action with the wrong tool, check whether
the tool surface can express its intent at all before tuning error messages.
Give it the capability the reference harnesses expose, and describe the real
runtime side effects of existing tools.
