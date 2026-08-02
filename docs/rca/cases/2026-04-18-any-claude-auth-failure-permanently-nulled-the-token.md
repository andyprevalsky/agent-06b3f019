---
id: 2026-04-18-any-claude-auth-failure-permanently-nulled-the-token
date: 2026-04-18
title: Any claudeAuth failure permanently nulled the workflow's Claude token, including 400s where the token was fine
surface: agents
component: claude-token-rotation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agent_workflow.py set self.claude_max_token = None on ANY claudeAuth failure, with no error classification
symptoms:
  - agent silently falls off claudeAuth for the rest of the workflow after one failed call
  - every later LLM call runs on the paid OpenRouter waterfall instead of the $0 Anthropic path
  - a malformed-request 400 kills the token just like a 401
tags:
  - claude-token
  - claudeauth
  - rotation
  - temporal-workflow
  - error-classification
sources:
  - memory:project_claude_token_retry_fix
repro: none-recorded
status: fixed
---

## Problem

After a single claudeAuth failure, an agent would fall off the Claude Max path
for the remainder of the workflow and run every subsequent LLM call through the
paid OpenRouter waterfall. This happened even when the failure was a 400
`invalid_request` — a malformed request body, where the token itself was
perfectly valid.

## Diagnosis

`agent_workflow.py` set `self.claude_max_token = None` on _any_ failure returned
from the claudeAuth path. There was no classification of the failure, so
"the request body was wrong" and "this token is revoked" were handled
identically, and the null was permanent for the life of the workflow. The deeper
owned cause is that rotation policy was being inferred from an unclassified
failure signal, and the decision lived in the wrong layer: the activity knew the
HTTP status but discarded it, and the workflow, which owns rotation and cooldown,
had nothing to decide on.

## Solution

The activity now reports a typed `claude_token_error` on the metadata/usage chunk
and the workflow owns rotation: 400 `invalid_request` falls through to the
waterfall _without_ marking the token; 401/403 `auth_error` calls
`mark_rate_limited` (rotating from the pool) and then falls through; 429 is
retried 3× inside `claude_auth.py` and on exhaustion behaves like 401; 5xx is
retried 3× and then falls through as `server_error`. Fall-through only happens
before any non-metadata chunk has reached the caller — after content has begun
streaming, errors propagate as normal `RoseError`s, because providers cannot be
switched mid-stream. Debug entry point: the `claude_token_error` field on the
activity result's usage dict. Owning code:
`agents/helpers/rose/client.py:_try_claude_auth` and
`agents/helpers/rose/legacy_adapter.py:classify_claude_token_error`.

## Human feedback

The recorded instruction is a placement rule: do NOT add token-rotation logic
inside the activity — keep rotation and cooldown in the workflow, and have the
activity only report the classified error type.

## Reusable lesson

Classify provider failures by status before acting on them, and keep credential
rotation in the layer that owns the credential lifecycle — never invalidate a
credential on an unclassified error.
