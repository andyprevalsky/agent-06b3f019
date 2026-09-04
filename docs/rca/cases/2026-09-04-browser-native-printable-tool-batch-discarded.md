---
id: 2026-09-04-browser-native-printable-tool-batch-discarded
date: 2026-09-04
title: Rose browser completion discarded all but the first printable press_key tool call
surface: agents
component: providers/rose browser-use completion normalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/providers/rose/client.py RoseClient.complete_browser_use — normalized response.tool_calls[0] and silently discarded the remaining native tool calls"
symptoms:
  - browser-biometrics-webdecoy emitted five printable press_key calls in one provider response but executed only the first
  - the model repeated one character per LLM turn and exhausted 60 browser steps before form submission
  - pre-deploy smoke agent 6f29f8ae timed out after 422 seconds against a 420-second cap
tags:
  - browser
  - rose-provider
  - tool-calls
  - press-key
  - biometrics
  - timeout
sources:
  - agent 6f29f8ae-59a4-474c-9305-2ee96eb21931
  - agent 8aefbb7c-d5b6-4911-9967-df6420626f33
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::complete_browser_use_printable_native_tool_batch
status: fixed
---

## Problem

The September 4 pre-deploy smoke timed out `browser-biometrics-webdecoy` at
422 seconds. The browser reached the form, but the email address consumed the
remaining action budget one character at a time and the task never completed.

The failing provider response at browser step 32 contained five native
`press_key` calls (`b`, `e`, `n`, `c`, `h`). Only `b` reached the browser. The
same loss repeated on later provider responses, expanding an intended batch
into 27 model/action turns.

## Diagnosis

Critical path:

`Claude native tool response -> RoseClient.complete_browser_use -> browser-use action normalization -> spawn_browser_agent_v3 action execution`

The provider response was correct at the source: it contained every printable
key. The first incorrect value appeared in `RoseClient.complete_browser_use`,
which passed only `response.tool_calls[0]` to the normalizer. The other calls
were silently discarded before the browser action layer could see them.

This was novel, not a recurrence. Archive searches used:

- `multiple native tool calls first tool call discarded browser press_key`
- `browser agent max steps character by character typing timeout`

The nearest prior case was
`2026-09-03-browser-biometrics-read-browser-state-burns-step-budget`, but its
first bad boundary was observation-step accounting, not provider tool-call
loss.

## Reproduction

The permanent provider-boundary blackbox preserves a response containing
multiple printable native tool calls and asserts that the completion returns
one focused `input_text` action with their exact concatenated text.

Buggy code, unchanged test:

```text
$ cd agents && venv/bin/python tests/blackbox/rose_browser_use.blackbox.py
❌ complete_browser_use_printable_native_tool_batch
AssertionError
```

Fixed code, identical command and assertion:

```text
$ cd agents && venv/bin/python tests/blackbox/rose_browser_use.blackbox.py
✅ complete_browser_use_printable_native_tool_batch
```

The full owning browser blackbox also passed after the change:

```text
$ cd agents && venv/bin/python tests/blackbox/spawn_browser_agent_v3.blackbox.py
✅ execute_focused_input_text_clear_false_hum
```

## Solution

`normalize_browser_use_tool_calls` now examines the complete native tool-call
list. When every call is `press_key` and every key is exactly one printable
character, it produces one focused `input_text` action with `clear=false`.
Mixed, stateful, or special-key batches preserve the historical single-action
behavior so the change cannot reorder clicks, navigation, shortcuts, or other
side effects.

Focused `input_text` already routes through `BrowserHumanizer.type_text`; it
therefore preserves per-character keyboard events and timing without guessing
an element index or issuing an invalid multi-character `press_key`.

The unchanged exact benchmark ultimately passed on the fully corrected tree:

```text
$ CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS=0 scripts/run-bench --local browser-biometrics-webdecoy
✅ browser-biometrics-webdecoy: PASS
RESULTS: 1/1 passed (100%)
Duration: 225s
```

Durable evidence:
`https://www.roselabs.ai/?agent-id=8aefbb7c-d5b6-4911-9967-df6420626f33`.

## Human feedback

The user required the isolation work to be finished and deployed, with no
known gate failure left behind.

## Reusable lesson

A provider-native response is an ordered tool-call collection, not a scalar.
If a product boundary intentionally supports one action per turn, it must
either reject extra calls explicitly or losslessly fold the narrow safe class;
silently indexing `[0]` converts valid batches into invisible data loss.
