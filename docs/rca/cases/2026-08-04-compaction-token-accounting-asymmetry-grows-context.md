---
id: 2026-08-04-compaction-token-accounting-asymmetry-grows-context
date: 2026-08-04
title: Two disagreeing token estimators let compaction grow the context it was asked to shrink, and a max(0.0) clamp hid it
surface: agents
component: context-compaction
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py:2278 `_estimate_tokens` counts only `m["text"]`, while agents/helpers/summarize.py:319 `_message_summary_weight` also counts metadata payloads — so compaction deletes near-zero-scored rows and adds a fully-scored summary
symptoms:
  - "Compaction did not get below overflow trigger"
  - "Context compression ineffective: compressed context estimate"
  - compressed_tokens greater than context_tokens
  - "saved_ratio": 0.0 while the context grew
  - agent marked FAILED immediately after a compaction attempt
tags:
  - compaction
  - context-window
  - token-accounting
  - observability
  - agent-failure
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: agents/.context-repro-c.py (scratch; to be promoted to agents/tests/blackbox/summarize.blackbox.py)
status: fixed
---

## Problem

Prod agent `e14d5abb`, 2026-08-03 04:21:53, level=error:

```json
{"context_tokens": 429743, "compressed_tokens": 431441, "trigger": 167000,
 "saved_ratio": 0.0, "event": "Compaction did not get below overflow trigger"}
```

Compaction ADDED 1698 tokens. The reported `saved_ratio` was `0.0`, not `-0.004`.
`run_agent.py:855` then returns `{"status": "error"}`, which
`agent_workflow.py:3712` turns into `_mark_failed` — a hard agent failure whose
user-visible message is the compaction arithmetic.

## Diagnosis

Two estimators measure different things:

* `_estimate_tokens` (`loop/run_agent.py:2278`) joins only `m["text"]`.
* `_message_summary_weight` (`helpers/summarize.py:319`) renders `text` PLUS
  `metadata.structured_response`, `tool_calls`, `attachments`, `file_pointer`.

In this agent's transcript every ASSISTANT row carries an empty message with the
whole payload in `metadata.tool_calls` (verified directly against the prod
transcript: all 6 ASSISTANT rows show empty text and populated `tool_calls`), and
TOOL rows carry their payload in metadata as well. Those rows are worth ~0 to the
caller's estimator but are fully rendered into the compaction prompt. Compaction
therefore removes almost nothing *as measured* and adds a real text summary that IS
measured. Net: measured growth.

Local reproduction (`agents/.context-repro-c.py`) builds a production-shaped context
of text-empty / metadata-heavy rows and observes the same signature:

```
messages          before=66  after=7
actual JSON bytes before=156996
context_tokens    = 25250   <- counts only m['text']
compressed_tokens = 26064
true saved_ratio     = -0.03224
reported saved_ratio = 0.00000   <- max(0.0, ...) clamp
```

59 messages and ~157 KB of real payload were discarded, and the measured context
still grew.

An earlier hypothesis — that sub-agent (`metadata.subAgentId`) rows caused the
asymmetry — was tested and REJECTED: `loop/context_utils.py:42` applies
`filter_internal_subagent_messages` to every polled batch before it reaches `context`,
so the exclusion inside `_estimate_tokens` is a defensive no-op on the real path.

This is two defects:

* **C1 correctness.** Neither `compress_context` nor `_compress_context` ever compares
  output size to input size. There is no guard anywhere in the compaction stack that
  the operation actually compacts.
* **C2 observability.** `run_agent.py:853` computes
  `saved_ratio = max(0.0, (context_tokens - compressed_tokens) / context_tokens)`.
  Negative savings are indistinguishable from zero savings in both the error log and
  the `MIN_AUTOCOMPACT_SAVINGS_RATIO` check, so growth cannot be alerted on.

Correction to the initial reading: the agent failed on the ABSOLUTE check
`compressed_tokens >= compaction_trigger`, not on `saved_ratio`. The clamp did not
cause the failure — it is why nobody noticed the growth earlier.

Open question deliberately left open: why the context reached 429743 estimated tokens
against a 167000 trigger before compaction fired at all. The text-only estimator
undercounting metadata payloads is the leading candidate and is the same root as C1.

## Solution

One estimator now serves both the overflow-trigger check and the compactor.
`agents/helpers/summarize.py` owns `estimate_context_tokens()` (text plus
`structured_response`/`tool_calls`/`attachments`/`file_pointer`) and
`compaction_saved_ratio()`, which is signed and never clamped;
`loop/run_agent.py:_estimate_tokens` delegates to it. The `max(0.0, ...)` clamp is
gone, so a compaction that grows the context is now visible instead of reporting
0.0. A non-reduction guard makes the compactor return `success=False` rather than
hand back a larger context, and `_compress_context` rejects a non-shrinking result
defensively because the activity can be an older out-of-process build.

Pre-fix the repro measured 25250 -> 26064 tokens with `reported saved_ratio 0.00000`;
post-fix 56914 -> 26058 with `saved_ratio 0.54215`. Cemented in
`summarize.blackbox.py` (4 tests), `run_agent.blackbox.py`, and
`run_agent_pure.blackbox.py`. Full agents suite 90/90; coverage 81% (fail_under 80).

A pre-existing hole was fixed alongside it: when the compactor circuit breaker was
open AND the context was still over trigger, the loop silently shipped an
over-window context to the provider every remaining iteration.

Proposed, not yet implemented. One estimator, used by both the trigger check and the
compactor, measuring what is actually sent to the model (text plus the metadata
payloads that get rendered). Add a size guard so compaction that fails to reduce is
detected as such, and stop clamping the reported ratio so growth is visible.

10k-agent behavior: fixes a per-agent hard-failure path; no shared state, no added
per-agent queries.

## Human feedback

None recorded.

## Reusable lesson

When two components measure the same quantity with different code, assume they
disagree — and never clamp a savings metric, because the clamp hides the exact case
worth alerting on.
