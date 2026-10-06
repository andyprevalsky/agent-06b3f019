---
id: 2026-09-28-wmh-blank-prediction-became-successful-explore-result
date: 2026-09-28
title: A reasoning-only WMH prediction became a successful empty explore result
surface: harness
component: rose-wmh-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/wmh_rose_provider.py RoseWMHProvider._complete_async accepts an empty RoseResponse.content as a successful WMH Completion
symptoms:
  - '"content": "", "is_error": false'
  - "completion_tokens=16384 finish=length"
  - "Result came back empty"
tags:
  - world-model
  - explore-agent
  - empty-result
  - reasoning-budget
sources:
  - agent 2547b90b-6977-4401-9e89-a6c1d909785c
  - benchmark run 20260928_185406_raise-5m-rose-labs-brex.json
repro: none-recorded
status: open
---

## Problem

In the unchanged 600-second fundraiser simulation, the root agent received two explore results rendered as `{"content": "", "is_error": false, "metadata": {}, "reward": null}` at 18:45:34 and 18:46:25 UTC. It interpreted the first as an empty successful research task, tried again, and spent more time researching investor prospects. Its latest reasoning at 18:47:48 UTC preceded the final outreach-child results, so those later results did not cause the observed confusion. The [published trajectory](https://www.roselabs.ai/?agent-id=2547b90b-6977-4401-9e89-a6c1d909785c) shows the resulting tool events and thoughts.

## Diagnosis

Both empty results correspond to `rose.explore.spawn_explore_agent` WMH steps in `.context/benchmarks/1790620966-1231809-40763/wmh-serve-log.txt`. Each used `qwen-3.8-27b` on `rose-1-flash`, consumed exactly 16,384 completion tokens, and ended `finish=length`; each completion log counted reasoning chunks and no content chunks. `RoseWMHProvider._complete_async` passed the empty `RoseResponse.content` to upstream WMH as a normal `Completion`. Upstream `parse_observation("")` returns `Observation(content="", is_error=False)`. Rose's `world_model_observation_to_tool_result` then sets `success=True`, and the specialized-agent handler passes the empty observation JSON to the parent. No model result was available, yet the tool reported success. This is the first bad owned boundary; the upstream parser and downstream wrapper propagate it.

The exact local boundary replay was run from `agents/` and exited 1 with `AssertionError: blank WMH completion must not become successful tool output`:

```bash
./venv/bin/python - <<'PY'
from wmh.core.parsing import parse_observation
from helpers.world_model_runtime import world_model_observation_to_tool_result
from domains.spawn_agent.handler import _world_model_specialized_result_text
empty = parse_observation("")
result = world_model_observation_to_tool_result(empty.model_dump(mode="json"), simulated=True)
print({k: result.get(k) for k in ("success", "message", "error")})
print(_world_model_specialized_result_text(result))
assert result.get("success") is False and result.get("error"), "blank WMH completion must not become successful tool output"
PY
```

The output was `{'success': True, 'message': '', 'error': None}` followed by the empty observation JSON. This reproduces the error mapping, but no fix or post-fix benchmark pass exists; keep the case open. Archive searches for `spawn_agent content empty is_error false metadata reward` and `tool result nested output category explore_result agent confused inconsistent envelope` found related sub-agent and envelope incidents, not this reasoning-only WMH boundary.

A separate source of confusion is malformed main-agent tool arguments: the archived `execute_loop` response at `1790621214123-9e19ccf71785` contains `items` as a JSON-looking **string**, while the advertised `spawn_agent` schema requires an array. Replay through that advertised JSON Schema failed on `items`. The agent incorrectly inferred that the harness had converted its list to a string. This is a distinct LLM/tool-generation boundary and is not diagnosed by the empty-WMH-result reproduction. A browser WMH result in the same run also exposed its full `{"output": {...}}` envelope instead of just the browser content because upstream's observation parser expects `output` to be a string; that is another distinct normalization defect.

## Solution

Not implemented. A general fix must reject blank or incomplete WMH provider completions before committing a successful step, then obtain a valid prediction through a bounded, observable recovery path. Preserve the original prompt, task evaluator, and 600-second benchmark while testing. Verify the unchanged boundary reproduction fails before and passes after the fix, register it in the WMH blackbox suite, and require the exact fundraiser to pass before calling the benchmark fixed. Do not treat a blank model response as successful research or increase a timeout to hide it.

## Human feedback

October 6 continuation: the HTTP regression now rejects six invalid completions, including empty output with a state note and state-note-only objects. Rejection happens before cache `done`; usage remains metered. The fixture also verifies object output, errors, scratchpad notes, production receipts and plaintext braces. A shared parser preserves fields the pinned parser would discard; runtime and benchmark mapping share one implementation. `.context/wmh-empty-contract-before.log` records three failures before repair, while `.context/wmh-empty-contract-after.log`, `.context/wmh-object-output-after.log` and the full WMH blackbox pass afterward. These contracts do not establish fundraiser success; this case remains open.

The user noticed that the main agent seemed confused by tool results and asked what was happening. They previously required WMH same-session LLM parallelism and a valid 10-minute trajectory, and asked that the timeout transition be considered separately.

October 6 native-v3 recurrence: nonempty JSON bytes containing a canonical
observation with empty inner `content` still bypassed the provider's visible
content check. Both a direct canonical envelope and the legacy `output`
wrapper reproduced the defect in provider and native commit tests (four
failures before repair; the identical assertions passed afterward). The shared
pure decoder in `agents/utils/world_model_observation.py` now checks the same
effective content the caller displays before cache completion or state commit.
The full WMH domain passes, including these regressions; this remains separate
from live conformance and the unchanged fundraiser outcome. The case stays
open until that benchmark has its own passing evidence.

## Reusable lesson

Reject empty model completions at the WMH provider boundary before they become successful tool observations.
