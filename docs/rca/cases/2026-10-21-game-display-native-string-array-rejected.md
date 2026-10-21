---
id: 2026-10-21-game-display-native-string-array-rejected
date: 2026-10-21
title: Game display attempts carried JSON-encoded strings where the tool requires arrays
surface: agents
component: structured-native-tool-response
classification: unresolved
problem_class: other
first_bad_boundary: qwen-3.8-27b native display.arguments.paths was a string containing JSON array text rather than the schema-declared array
symptoms:
  - Root completed with game.html attached but no playable display message
  - DisplayRoseDesktopTool.paths Input should be a valid list twice
tags:
  - display
  - native-tools
  - cerebras
  - structured-output
  - game
sources:
  - agent 446016aa-fb3d-4251-955c-4512546afb43
  - plan:.llm-dumps/446016aa-fb3d-4251-955c-4512546afb43/1792541723542-a99a73a85ce3-execute_loop.json
  - plan:.llm-dumps/446016aa-fb3d-4251-955c-4512546afb43/1792541725918-a99a73a85ce3-execute_loop.json
  - plan:.llm-dumps/446016aa-fb3d-4251-955c-4512546afb43/1792541727000-a99a73a85ce3-execute_loop.json
repro: /tmp/replay-display-native-arguments.py uses exact captured native display call through call_llm_structured_streaming
status: open
---

## Problem

The unchanged “Make me a game” root completed in 218.4 seconds with game.html,
but its conversation lacked a playable display. The root did try display twice.
Both native qwen-3.8-27b responses supplied `paths` as the string
`["game.html"]`, rather than an array. Validation rejected both attempts.
The initial hypothesis that the root never requested display is contradicted
by the captured calls and is discarded.

## Diagnosis

Path: declared DisplayRoseDesktopTool schema → Cerebras request body → captured
native tool arguments → structured-response reconstruction → AgentAction
validation → display execution. The first bad value is already in the native
response, before reconstruction. `build_cerebras_body` preserves the exact
`paths` schema (`anyOf` array-of-string or null); it does not replace it with a
string schema. Legitimate free-form tool shapes disable strict decoding for
the whole toolset by existing provider policy; this is not evidence of a
projection bug.

After two schema-invalid responses from the same actual model, the existing
structured-parser policy excludes that candidate. The fallback
`gpt-5.6-luna-foundry` then itself returned `attempt_completion({})`. Its dump
retains the paired list-validation feedback; no evidence shows the adapter
inventing completion or dropping that feedback. This is an actual observed
agent failure, not a proven source bug or a proven model-intelligence limitation.

Archive/code searches used literal `valid list`, `string-array`, `display` and
behavioral `native tool argument normalization`, `structured validation
failover`. Existing llm blackboxes intentionally reject JSON-encoded list
strings. A global coercion would change those acceptance rules, so none was
implemented.

## Reproduction

`/home/boxes/rose/agents/venv/bin/python /tmp/replay-display-native-arguments.py`
replays captured call ea35eb045 through the actual structured streaming parser.
Only provider IO is replaced. It fails with `LLMStructuredOutputError` and
`tool_calls.0.paths: Input should be a valid list`. Log:
`/tmp/display-native-before.log`. It also verifies source and Cerebras-projected
paths schemas are equal. No live provider request was made.

## Solution

DisplayRoseDesktopTool now decodes well-formed JSON array strings once for
paths, urls and options, then runs the same existing typed item validation and
downstream file/security checks. Stock DisplayTool and every generic tool keep
their original rejection contract. The declared JSON schema and all prompt text
are unchanged. This narrow reversible decoder follows the established
ResponseSchemaConfig JSON-container normalization; parent confirmed existing
feature-fix authorization covers it. No new human approval gate is asserted.

The permanent schema regression was run against unchanged source first and
failed with valid-list errors for all three fields. The same regression passes
after the decoder. The registered llm regression replays native call ea35eb045
through the actual structured parser and returns paths=['game.html'] in one
call. The unchanged generic typed-list rejection/failover regression still
passes. Negative controls reject malformed JSON, nonarrays, invalid list
members and missing option labels; caption literal and stock display rejection
are unchanged. No global adapter coercion, prompt nudges or benchmark changes.

Commands: `/home/boxes/rose/agents/venv/bin/python /tmp/run-display-registered.py`
before and after; logs `/tmp/display-registered-before.log` and
`/tmp/display-registered-after.log`. The driver calls the checked-in tests:
`tool_schemas.blackbox.py:test_desktop_display_decodes_json_arrays_without_changing_stock_or_item_validation`
and `llm.blackbox.py:test_captured_desktop_display_native_json_array_reaches_typed_action`.
Both are registered in their canonical owning blackbox suites. Focused
regressions passed five successive runs, including unchanged generic rejection.
The exact original GUI goal remains for the UI lane's authorized outcome rerun;
this case stays open until that succeeds. No paid request was made here.

## Human feedback

Preserve rejection acceptance for generic typed tools. Do not patch the schema
or normalize all provider arguments merely to make this game pass. Distinguish
actual malformed model output from a demonstrated adapter defect; preserve the desktop-only decoder scope and established typed checks.
Parent confirmed no additional approval is required for this code-only fix. Exact child closure and private-stack shutdown were received before
any source or archive edit.

## Reusable lesson

Read the captured calls before inferring that an agent omitted an action.
A failed display invocation is different from an omitted display invocation.
Compare the actual provider request schema and response at the first bad
boundary; a permissive decoding mode does not itself prove schema corruption.
