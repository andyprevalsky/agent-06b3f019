---
id: 2026-03-26-rose-passthrough-swallows-claude-token-error
date: 2026-03-26
title: OpenRouter passthrough chunks in the Rose endpoint silently swallowed `claude_token_error`
surface: agents
component: rose-client
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: Rose completions endpoint — OpenRouter passthrough chunk mapping dropped the `claude_token_error` field instead of emitting it in the stream
symptoms:
  - claudeAuth failures appear only as an unexpected `actual_model` in the response
  - "claude_token_error" absent from streaming completion events
  - direct-Anthropic rejection is indistinguishable from a normal waterfall win
tags:
  - rose
  - claude-auth
  - streaming
  - error-propagation
  - observability
sources:
  - PR #264
repro: none-recorded
status: fixed
---

## Problem

When the direct-Anthropic (claudeAuth) attempt failed and the request fell
through to the OpenRouter waterfall, the resulting stream contained no signal
that a Claude token error had occurred. The only way to detect the failure was to
notice that `actual_model` was a non-Claude model — which is exactly how the
execute-phase schema bug (18 union-typed parameters → HTTP 400) stayed hidden.

## Diagnosis

The Rose endpoint's OpenRouter passthrough path forwarded provider chunks
verbatim but did not carry the `claude_token_error` field into the emitted
streaming completion events. Because the fallback itself is a _success_ path —
the waterfall answers, the agent proceeds — a dropped error field produces no
downstream failure to notice. Silent degradation on a fallback path is
strictly harder to detect than a hard failure, so the missing field converted
every claudeAuth defect into an "it works, just costs money" condition.

## Solution

Included `claude_token_error` in the streaming completion events emitted from the
OpenRouter passthrough path, so any claudeAuth rejection is visible in the stream
rather than inferred from the model name. This also makes the sibling failure
mode — a call site that never passed `claude_token` at all — observable.

## Human feedback

None recorded.

## Reusable lesson

A fallback path that succeeds must still emit the error that caused the fallback;
otherwise every upstream defect degrades silently into extra spend.
