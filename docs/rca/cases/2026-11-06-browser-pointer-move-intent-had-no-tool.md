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
  - agent e04e7558-afdb-412a-a023-e6ccfba54e67 (local fix run on cce696e9d, PASS)
  - commit cce696e9d
  - commit 15f2ef6cf
  - PR #1703
  - agent 3c057de1-d449-49b9-b76c-a5c72ca3d140 (cloud, f25d7c064, PR #1730 deploy, 3 drags, 0.164)
  - agent c19b68c8-5306-4f81-ab50-9fee95a7760d (cloud, 2731bfe53, PR #1725 deploy, 3 drags, 0.164)
  - agent 97aa455f-1fe8-407b-9fa5-f8bad701fc71 (local control on db5b15de9, no drag, 0.057, PASS)
  - agent d5672824-be5a-4873-839a-351de889f6e3 (cloud on merged fa676edc7, hover, 0.0906, PASS)
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
2. The runtime already moves the pointer: every humanized click calls
   `humanizer.click_at_coords`, which synthesizes a human trajectory with
   overshoot before pressing (`agents/browser_tools/humanizer.py`). The
   browser-use fallback without a humanizer also sends `mouseMoved` first.
   `humanizer.hover()` also exists. The tool descriptions said only
   "Click element by index", and no tool exposed hover. `evaluate`'s
   description even routes "hover, drag" to JavaScript, which this task
   forbids.
3. So pointer movement could only be expressed as `drag` (press, hold,
   release). Two consequences followed.
   - Score: the v3 dispatcher ran drag through raw CDP (`_execute_drag`). That
     moves the pointer straight to the start point and presses there, with no
     trajectory. FCaptcha reported `vision_ai: Click injected with no pointer
     trajectory (1 teleport clicks)` on dc306296 (one drag, 0.164 > 0.163) and on
     the local buggy run 1eeef95c (one valid drag at step 6). The fixed runs
     d920016a and e04e7558 made no drag and returned `detections: []`. The
     existing `humanizer.drag_between`, which approaches the start along a
     trajectory, was never called. In 8d029581 (0.187) the checkbox had already
     failed before its drags, so its drags are not the first cause there, and
     its detections were not captured.
   - Loop: when the model wanted to move toward the submit button it emitted
     `drag({"end_x":480,"end_y":408,"steps":20})` with no start point. At step
     6 of the same run it had done the same move with a start point before
     clicking the checkbox. All 177 rejected turns have empty thinking, so the
     "move from the current position" intent is an inference from that run.
     The harness does not bound identical rejections: `handler.py` resets
     `consecutive_api_failures` on every rejection, and the model repeated the
     identical call (repetition collapse) instead of adapting. The cloud run's
     rejected arguments were never captured (see the observability gap below);
     the end-only shape is known from the local reproduction only.
4. Causal replay of the captured step-6 decision of 1eeef95c (a valid
   pointer-faking drag) through RoseClient: recorded tools chose drag 7/10
   (click 1, scroll 2); descriptions only, 3/10 (scroll 7); descriptions plus
   hover, 2/10 (scroll 8, hover 0). The drop came from the model deferring with
   scroll, not from choosing hover. The fixed history of that replay already
   contains the earlier "use drag to simulate movement" reasoning, and that
   bias was not tested further. The outcome evidence is end-to-end. In two fresh
   local runs on the fix the model called `hover` before its clicks
   (d920016a: `hover(index 2774)`; e04e7558: `hover(index 2773)` and
   `hover(index 2826)`), made no drag, and passed (142 s and 138 s, risk 0.06).

Step 5a ladder: why drag? No pointer-only move (deepest owned cause). Why did
it loop? The end-only move intent cannot be expressed in drag, and identical
rejections are unbounded (consequence of the same gap; the loop mechanism is
inferred, not replayed). Next rung, "the tool surface lacks some primitive the model wants",
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

Commits cce696e9d and 15f2ef6cf:
- `hover` browser tool (`HoverTool`: index or x+y), dispatched in
  `service_actions._execute_hover`. It calls `humanizer.hover()`, or without a
  humanizer sends one CDP `mouseMoved` (the same fallback as an unhumanized
  click). It never presses. It is registered in normalize, `_VALID_ACTIONS`,
  the handler tool-argument redaction fields, the awaiting-observation set and
  state prefetch.
- Drag runs through `humanizer.drag_between` when a humanizer exists, so the
  press follows a pointer trajectory rather than a teleport. The raw CDP path
  remains for unhumanized sessions.
- Descriptions say only what holds in every input mode. `click` and
  `click_coordinates` move the pointer themselves before pressing. `hover`
  uses the same pointer movement as click. `drag` holds the button, is never
  for moving the pointer, and needs both ends. `evaluate` no longer routes
  hover/drag to JavaScript.
- `humanizer.drag_between` (now on the live path) releases the button and
  fails the drag when a CDP pointer move breaks after a CDP press. Before, it
  continued with Playwright moves that had no matching press and reported
  success (CodeRabbit finding on PR #1703; regression
  `humanized_drag_fails_when_cdp_move_breaks_after_press`).
- Rejected tool-arg decisions are now dumped (`tool_args_validation_error` in
  output) before the loop feeds the rejection back.
- Regressions: rose_browser_use `pointer_move_intent_has_hover_tool`,
  `pointer_tool_descriptions_match_runtime`, `rejected browser tool args are
  still dumped`; spawn_browser_agent_v3
  `execute_action_hover_moves_pointer_without_pressing` and
  `humanized_drag_approaches_start_before_pressing`. The first four failed on
  24b862375 and pass on the fix. The phone-off byte pin was re-pinned for the
  tools hash only; the system and message hashes are unchanged.

Sibling failures prevented: slider and drag-and-drop drags no longer press at a
teleported pointer. Hover-revealed menus and tooltips no longer need JavaScript
(untrusted events). Not done (rule 25a): no harness repeat-breaker for
identical rejected calls. 10k agents: one extra tool definition per browser
request; hover and drag stay per-session pointer input with no shared state.

## Further pre-merge observations (2026-11-06)

Two more cloud smoke failures hit this case before PR #1703 merged
(fa676edc7). Both ran on source without the fix (052ac6ce7 is an ancestor of
fa676edc7, not of either failed source), so neither is a recurrence after the
fix. Each reported `FCaptcha captured API risk score 0.164 exceeds ratchet
0.163` with `vision_ai: Click injected with no pointer trajectory (3 teleport
clicks)`, plus datacenter-IP, three-speech-voice and missing-Segoe-UI
detections that describe the Tilion browser environment rather than pointer
behaviour.

- PR #1730 deploy on f25d7c064, agent 3c057de1, Hub run
  20261106-103815-953003-m7cf1c7ff9d3f (source, run and error recorded in
  `docs/handoffs/pr-1730-closeout/evidence/repair-goal-webdecoy.txt`).
- PR #1725 deploy on 2731bfe53, agent c19b68c8, Hub run
  20261106-095657-2926622-mc29e58eff36d (source, run and error recorded in
  `docs/handoffs/pr-1725-closeout/evidence/repair-evidence-webdecoy-fcaptcha-owner.txt`).

Neither run hit the rejected-drag loop. Each browser agent reasoned it would
move the mouse "using drag" and made three accepted drags before the checkbox
click (c19b68c8 split them around a scroll). Its other clicks and typing went
through the humanized `click_at_coords` path, so the three teleport clicks are
consistent with the three raw-CDP drag presses. The Hub exports carry no
worker logs, so a non-humanized click fallback cannot be fully excluded.
c19b68c8 also reported a browser-session cleanup error after completion. That
error is unrelated to the score.

A local control run (agent 97aa455f) was launched from the main checkout at
db5b15de9 without the fix. The SHA is the checkout HEAD at launch; the run
record does not store it. That run made no drag and scored 0.057. This is
consistent with drag being the discriminating variable, but it is one local
run compared with cloud failures. The fix's regressions
`humanized_drag_approaches_start_before_pressing` and
`execute_action_hover_moves_pointer_without_pressing` fail on db5b15de9 and
pass on 052ac6ce7.

Outcome on the merged fix: `scripts/run-bench browser-biometrics-webdecoy
--ref fa676edc7 --wait` (cloud fleet, Tilion, run 20261106-131544-295004,
agent d5672824, receipt base_sha fa676edc7) passed in 133 s with captured risk
0.0906. It made no drag, called `hover` before its clicks, and had no
`vision_ai` or teleport detection. Summary and receipt hash:
`docs/handoffs/pr-1735-closeout/evidence/cloud-pass-fa676edc7.json`. The
control and cloud-pass ledger rows are in
`docs/handoffs/pr-1735-closeout/evidence/ledger-rows-pending-main.jsonl`.

## Human feedback

None recorded.

## Reusable lesson

When a browser model keeps faking an action with the wrong tool, check whether
the tool surface can express its intent at all before tuning error messages.
Give it the capability the reference harnesses expose, and describe the real
runtime side effects of existing tools.
