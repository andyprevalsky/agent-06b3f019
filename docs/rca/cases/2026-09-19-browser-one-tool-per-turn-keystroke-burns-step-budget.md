---
id: 2026-09-19-browser-one-tool-per-turn-keystroke-burns-step-budget
date: 2026-09-19
title: One-tool-per-turn single-char input_text burned MAX_ITERATIONS before Submit
surface: agents
component: spawn-browser-agent-v3 / step budget
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/config.py adjust_iteration_after_action + service_actions._execute_indexed_input_text — counted each clear=false 1-char input_text as a full step and re-clicked the same field"
symptoms:
  - Timeout after 422s (dynamic cap=420s)
  - Agent status: PAUSED (expected COMPLETED)
  - Max iterations (60) reached
  - Typed 'b' into <input placeholder="you@example.com">
  - browser-biometrics-webdecoy failed 478s
tags:
  - browser
  - smoke
  - biometrics
  - webdecoy
  - input-text
  - step-budget
  - timeout
sources:
  - agent 065aee2c-a581-41b9-81f9-634a8bb1bb51
  - hub run 231d6614-b823-42e7-a4e1-23d64336bcf3
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_single_char_input_text_continuation_does_not_consume_step_budget
status: fixed
---

## Problem

Pre-deploy smoke `browser-biometrics-webdecoy` ran serially first on the
isolated :3201 stack and timed out at 422s / cap 420s. Agent `065aee2c`
stayed PAUSED. The browser sub-agent hit **Max iterations (60)** at
00:19:40 while still typing the message field — it never submitted.

Recorded actions on the first session: 35 `input_text` + 20 `wait` + 6
`click` + 5 `read_browser_state` + 2 `scroll` + 1 `goto`. Every
`input_text` typed exactly one character (`b`, `e`, `n`, …) with
`clear: false` after the first, and `_execute_indexed_input_text` issued
a full humanized click before each keystroke. The parent then spawned a
second browser session; the harness paused the tree.

Not contention with the Step 5 :3001 stack: this task ran exclusive /
serial, root cost stayed ~2c, and spans show continuous tool work rather
than idle gaps after the first LLM call.

## Diagnosis

Archive searches: `Timeout after 422s browser-biometrics-webdecoy PAUSED`,
`browser biometrics webdecoy timeout stall idle`,
`browser session hang spawn_browser_agent timeout cap=420`. Relative of
`2026-09-04-browser-native-printable-tool-batch-discarded` (same symptom,
different first-bad boundary) and
`2026-09-03-browser-biometrics-read-browser-state-burns-step-budget`
(same budget class, observation not keystrokes). Novel as a recurrence:
the 2026-09-04 guardrail only folds same-response `press_key` batches.
This run's system prompt says "You must call exactly one available
browser action tool", so the model emitted one `input_text` char per
turn. No batch existed to fold.

Critical path: task "type character by character" → one-tool-per-turn
prompt → `input_text({text:"b", clear:false})` → indexed path always
`click_at_coords` + `type_text` → `iteration += 1` with no keystroke
refund → 28-char email + message + waits > 60 → max steps → parent
respawn → 420s PAUSE.

Step 5a: planner-turn granularity is finer than the tool's native
capability (`input_text` already humanizes a full string). That class
also covers 1-char `press_key` appends. Next-deeper class (tell the
model to pass the complete string via a prompt/tool-description edit)
is coherent but LLM-visible; the execution-layer refund + skip-refocus
eliminates the class without changing what the model reads.

## Solution

`adjust_iteration_after_action` refunds single-printable-character
`input_text`/`press_key` appends (`clear=false`) up to 128 consecutive
keystrokes. `_execute_indexed_input_text` / coordinate path skip the
humanized re-click when the last successful action already focused the
same index. `normalize_browser_use_tool_calls` now also folds a
same-index 1-char `input_text` batch into one string (sibling of the
2026-09-04 `press_key` fold).

10k-agent: per-agent counters only; no shared lock or fan-in. Sibling
failures: any one-tool-per-turn form fill (passwords, checkout fields,
search boxes) that types visible keystrokes.

## Human feedback

None recorded. Parent deploy instructed not to bump the 420s cap and
not to revert the stuck chat-mode escalation fix.

## Reusable lesson

When the browser loop is one planner tool per turn, a keystroke primitive
that the tool already implements internally must not consume
MAX_ITERATIONS or re-click an already-focused field.
