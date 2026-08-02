---
id: 2026-07-21-gemini-fallback-unbounded-reasoning
date: 2026-07-21
title: Synchronous chat fallback to Gemini via OpenRouter sent no reasoning effort, so mandatory medium reasoning added ~10s
surface: back-end
component: rose-client
classification: our-bug
problem_class: other
first_bad_boundary: the synchronous chat generator did not set `reasoning.effort` on the OpenRouter waterfall request, so Gemini applied its default medium mandatory reasoning
symptoms:
  - chat completion takes 11.65 seconds after Cerebras silence triggers the Gemini fallback
  - "1,886 hidden reasoning tokens billed on a structured-output chat completion"
  - slow prod chat lifecycle runs only on the OpenRouter fallback path
tags:
  - rose-client
  - openrouter
  - gemini
  - reasoning-effort
  - chat-latency
sources:
  - PR #821
repro: none-recorded
status: fixed
---

## Problem

Production lifecycle runs showed Cerebras going silent and the request falling
through to the Gemini fallback, where completion took **11.65 seconds**. Gemini 3.5
Flash generated up to **1,886 hidden reasoning tokens** on a request that only needed
structured output. Equivalent structured-output probes with minimal effort completed
in **1.7–2.1 seconds**.

## Diagnosis

Gemini 3.5 Flash defaults to _medium mandatory_ reasoning: if the caller says
nothing about reasoning effort, the model spends thousands of hidden tokens before
answering. The synchronous chat generator never set `reasoning.effort` on the
OpenRouter waterfall request, so the fallback path inherited that default. The
primary path never exhibited the latency, which is why this only appeared when
Cerebras went silent — the defect lived entirely in the untested fallback branch.
The deepest owned cause is ours, not the provider's: an unspecified reasoning
parameter means the provider chooses, and we had no default for the fallback.

## Solution

Send `reasoning.effort=minimal` when synchronous chat generation falls back through
OpenRouter, while preserving existing reasoning defaults for routers and non-chat
Rose callers so nothing else changes behavior. Covered by tests on the generator
options and on the exact Gemini waterfall request body, so the parameter can't be
dropped again silently. The configured reasoning effort is now also preserved
through OpenRouter routing and waterfall attempts.

## Human feedback

None recorded.

## Reusable lesson

Latency that only appears on a fallback provider usually means an unset generation
parameter defaulting differently there — pin reasoning effort (and other
cost/latency-bearing params) explicitly on every waterfall branch, not just the
primary.
