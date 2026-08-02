---
id: 2026-03-26-claude-token-not-forwarded-by-param-populator
date: 2026-03-26
title: param_populator did not forward `claude_token` to the structured-streaming LLM call
surface: agents
component: param-populator
classification: our-bug
problem_class: other
first_bad_boundary: agents/activities/param_populator.py — call to `call_llm_structured_streaming` omitted the `claude_token` argument
symptoms:
  - param populator LLM calls never route to the direct Anthropic path
  - "claude_token_error" never surfaces from param populator calls
  - one call site bills the paid waterfall while sibling calls use claudeAuth
tags:
  - claude-auth
  - claudeauth-threading
  - param-populator
  - structured-output
sources:
  - PR #264
repro: none-recorded
status: fixed
---

## Problem

While root-causing the execute-phase claudeAuth failure, the param populator was
found to call `call_llm_structured_streaming` without passing `claude_token`.
That call site therefore could never use the user's Claude OAuth credential and
could never report a `claude_token_error`, so any token problem on that path was
invisible.

## Diagnosis

`claude_token` is threaded explicitly, argument by argument, from the workflow
down through each LLM call site rather than carried in ambient/shared state. That
makes every new or refactored call site a place where the credential can be
dropped silently: the call still succeeds, it just races on the paid waterfall
instead of hitting Anthropic directly, and no error is raised because a missing
optional argument is legal. The deeper enabling cause is a per-call-site opt-in
contract with no invariant that every structured-streaming call carries the
token.

## Solution

Passed `claude_token` through from `param_populator.py` into
`call_llm_structured_streaming`, so token-related errors are surfaced and the
call can use claudeAuth like every other agent call site. Shipped alongside the
union-schema fix in the same PR because both suppressed the same observable —
"claudeAuth is on, but this call did not go to Anthropic".

## Human feedback

None recorded.

## Reusable lesson

When one LLM call site is inexplicably on the paid waterfall while its siblings
use claudeAuth, grep that call site's arguments for a dropped `claude_token`
before investigating the provider.
