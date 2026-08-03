---
id: 2026-03-03-unbounded-llm-request-logging-oom
date: 2026-03-03
title: Backend OOM from pretty-printing full LLM request bodies on every completion call
surface: back-end
component: chat-completions
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/lib/chat/supabaseCompletions.ts — full LLM request body (conversation history + base64 images) dumped pretty-printed per call
symptoms:
  - backend out-of-memory crash in production
  - MB+ of log output accumulating per LLM iteration
  - NodeCache rejects new entries once the shared-memory cache is full
tags:
  - logging
  - out-of-memory
  - llm
  - cache
  - node
sources:
  - PR #188
repro: none-recorded
status: fixed
---

## Problem

The backend crashed with out-of-memory in production. The proximate evidence was
log volume: `supabaseCompletions.ts` serialized the _entire_ LLM request body —
all conversation history plus base64 image payloads — with pretty-printing on
every single LLM call, accumulating MB+ per iteration.

## Diagnosis

Two memory sinks, both unbounded in the number of agent iterations:

1. **Log serialization.** Nothing truncated the logged payload, so the log cost
   scaled with conversation length and attachment size rather than with a fixed
   budget. Seven HIGH-risk call sites (LLM requests, request payloads,
   diagnostics, session objects, Vapi responses) and eleven MEDIUM-risk sites
   (external API error responses from Gmail, Surge, OpenRouter, Vapi, Cerebras)
   all had the same shape.
2. **Shared-memory cache.** `NodeCache` was configured such that a full cache
   _rejected new entries_ instead of evicting old ones, so the cache was both a
   retention sink and a correctness hazard once saturated.

The deepest owned cause is that verbose developer-grade logging shipped to
production unchanged: the debug affordance had no environment-aware ceiling.

## Solution

Added `logJson()` and `logTruncate()` utilities that truncate to 500 chars in
production while keeping verbose output in dev, and applied them to all 18
identified call sites rather than only the one that crashed. Replaced
`NodeCache` with `LRUCache` capped at 500 entries with automatic LRU eviction,
so cache pressure degrades gracefully instead of failing writes. All 28 backend
tests passed, plus 17 new tests covering get, set, hash-based 304s, appends,
deduplication, and concurrent eviction.

## Human feedback

None recorded.

## Reusable lesson

Never serialize an unbounded request/response payload into a log line — route
every payload log through a truncating helper whose ceiling is fixed, not
proportional to the conversation.
