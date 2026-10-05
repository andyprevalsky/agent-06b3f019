---
id: 2026-07-07-fast-cache-replay-returns-before-llm-context-dump
date: 2026-07-07
title: Fast-cache replays return before dump_llm_context, so a fully-replayed run captures zero LLM context dumps
surface: agents
component: rose-client
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: "agents/providers/rose/client.py:556 — RoseClient.complete() returns at llm.cache.replay, before dump_llm_context at :619"
symptoms:
  - "a fully fast-cache-replayed run emits no llm.context.dump events"
  - no LLM context available when investigating a replayed benchmark/demo run
tags:
  - fast-cache
  - observability
  - llm-context-dump
  - clickhouse
  - replay
sources:
  - memory:project_foreach_tree_vanish_fe_merge
  - PR #1299
  - agent 71b15f0f-6eca-4c35-b00c-77ecd2cfdd4d
repro: agents/tests/fast_cache/test_fast_cache.py
status: open
---

## Problem

While investigating DEMO run `60ac085d` (fully fast-cache replayed) there were zero
`llm.context.dump` events to read, so the run's prompt context could not be
inspected from its own trace.

## Diagnosis

`RoseClient.complete()` (`agents/providers/rose/client.py`) returns at the
`llm.cache.replay` branch on line 556, which is BEFORE `dump_llm_context` at line 619. Context capture is therefore coupled to the live-completion code path rather
than to the completion event itself, so any replayed call is invisible to the
trace-capture layer. The practical consequence for diagnosis: for a replayed run the
real context lives on the seed/recording run instead, recoverable by decoding the
`llm.context.dump_updated` `payload_gzip_b64` from ClickHouse.

## Solution

Not fixed at the time of the record. The generalizable direction is to emit the
context dump on every completion path — including cache replay — so trace capture is
independent of whether a call was served live or from cache.

## Human feedback

None recorded.

## Reusable lesson

Emit observability on the completion path both the live and cached branches share —
otherwise a replayed run silently produces no trace, and look for the context on the
seed/recording run instead.


## 2026-09-11 recurrence and causal proof

The unchanged `test-mass-agent-run-0` task produced 3,064 cache completions
before its deliberately shortened 300-second execution limit. Its root had
no LLM dump, so durable publication failed. The encrypted cache-read archive
retains responses and keys, not the current request messages; it cannot be
presented as a complete original context. The benchmark timeout is a separate
outcome and is not claimed fixed by this observability change.

The owning-boundary regression uses the real central `RoseClient.complete`
and compatibility `cached_complete` entry points, an in-memory external cache
store, the actual replay stream, and the real local dump writer. Before the
fix, both enabled-capture cases fail with zero files; both disabled cases
pass. Afterward all four pass unchanged, preserving every emitted chunk and
asserting no live provider call or cache write. Five additional cases cover
both synthetic terminal passthrough entry points, consumer abandonment, and
start/finalize capture failures. The full fast-cache suite passes 159 tests.

A shared `replay_with_context` adapter now captures current request messages,
declared tools/schema and safe generation settings, then folds the actual
emitted replay into the dump. Provenance explicitly records `fast_cache`,
lookup and hit keys, the replay/passthrough reason, and the recorded model.
The actual model is `fast-cache`; replay output tokens remain zero. Partial
consumption is marked `replay_complete: false`. Both cache entry points use
this adapter for every replay branch. It neither edits cache entries nor
adds provider traffic. Capture errors remain best-effort.

Per-call capture uses the existing local/production observability sinks and
adds work proportional to that call's context and output, without a global
lock. Large replay fan-outs therefore add real disk/archive work; the exact
five-minute mass benchmark rerun will measure the resulting behavior. No
claim of zero overhead or of successful benchmark completion is made.

Private before/after logs are under
`.context/acceptance/completion-dump-rca/`. The case remains open pending the
real replay-run capture/publisher check and adversarial review. The user
requires the current five-minute task limit and normal 120-minute backstop;
this change alters neither those limits nor task prompts and evaluators.


Independent review strengthened the partial-consumer regression to close
both public entry points and inspect the file before another event-loop
turn. Both originally returned before the delegated replay finalized.
Explicit `aclosing` at every cache delegation now completes that update
before the caller's close returns; the unchanged public-boundary and
independent reproductions pass. The complete cache suite now passes 160
cases. The first real mass capture rerun exposed cross-root archive outbox
adoption, tracked separately in
`2026-09-11-archive-retry-adopted-retired-root-backlog`. It was interrupted
and cannot provide a successful outcome or canonical durable bundle.


After root-scoped archive recovery, the unchanged five-minute mass run
`2d23ad00-f362-4967-aa9c-ae5b9b4c5bb9` captured replay input/output and its
canonical publisher verified the durable FE and last dump for root
`420c5fd8-c9f6-4b19-91af-140c68f9d305`. The root paused at 300.8 seconds and
all owned local services/database resources were cleaned. The task remains
FAILED under the temporary cap; capture success is a separate result. Its
normal-budget qualification and the combined-tree gates remain pending.
