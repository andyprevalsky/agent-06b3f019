---
id: 2026-09-30-normalized-coordinate-click-lost-in-browser-history
date: 2026-09-30
title: Normalized coordinate click reappeared as an empty click in browser history
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py browser turn reconstruction discarded coordinates and advertised click instead of click_coordinates
symptoms:
  - browser-biometrics-webdecoy timeout after 420s
  - click_coordinates reappeared as click({}) in browser LLM history
tags:
  - browser-agent
  - coordinate-click
  - tool-history
sources:
  - PR #1063
  - agent d4ef948a-aaa3-441a-bce5-ae2a74e56076
  - agent 35993529-24a9-4776-92b9-3f6f07772dab
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The unchanged `browser-biometrics-webdecoy` smoke task timed out at its 420 second cap on agent `d4ef948a-aaa3-441a-bce5-ae2a74e56076`. That run used `click_coordinates` repeatedly. The browser LLM's next-turn history represented a successful coordinate click as `click({})`, omitting both coordinates. The run did not reach a completed result. The later fixed-worktree benchmark passed in 375.3 seconds, but that trajectory did not call `click_coordinates`; its pass is outcome evidence, not direct evidence that the repaired coordinate path caused the improvement.

## Diagnosis

The provider intentionally normalizes `click_coordinates` to internal action `click` plus a `coordinates` object. `_browser_tool_arguments` copied coordinates only when the action name was still `click_coordinates`, so it emitted `{}` after normalization. `_append_browser_turn_messages` then wrote the internal name `click` into model history. The failed transcript shows the browser agent saying it kept calling `click` instead of `click_coordinates` and encountering invalid-index errors. The first wrong boundary was the conversion from normalized browser action to model-visible tool call. A local replay using the coordinates observed in the run printed `before {"name": "click", "arguments": "{}"}`; the same replay on the fixed worktree printed `after {"name": "click_coordinates", "arguments": "{\"x\":527,\"y\":443}"`. The deepest proven cause is that execution and replay used different names and argument rules for the same action, without a regression check for coordinate clicks. Archive searches for `click_coordinates click empty arguments browser` and `explore agent timeout partial evidence fallback` found related cases, but none at this history-reconstruction boundary.

## Solution

The browser handler now copies coordinates from normalized `click` actions when no DOM index is present and writes `click_coordinates` with x/y arguments into the next LLM turn. `test_browser_turn_history_preserves_coordinate_click_tool_call` checks that exact call. The browser blackbox suite passed, and the unchanged WebDecoy task passed on the fixed worktree; because the passing run did not use coordinate clicks, the benchmark's causal attribution remains limited. The fix prevents any coordinate click from being replayed as `click({})` across browser tasks. At 10k agents it changes only in-memory transcript content for coordinate clicks, with no new external call or persistent data.

## Human feedback

The user requested accessible trajectory links and an approval explanation in `/RCA` format. No deployment approval was given in this exchange.

## Reusable lesson

Replay normalized browser actions to the model with the advertised tool name and complete arguments.
