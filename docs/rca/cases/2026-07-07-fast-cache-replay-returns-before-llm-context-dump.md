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
repro: none-recorded
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
