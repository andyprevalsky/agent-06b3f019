---
id: 2026-04-23-smoke-agents-inherit-real-user-context
date: 2026-04-23
title: Smoke benchmark agents inherited the real user's personal context and ignored the test goal
surface: agents
component: smoke-benchmarks
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: smoke benchmark agent creation — agents created with Andy's real user_id, so get_user_context injected recent messages/contacts
symptoms:
  - "2/5 smoke benchmarks failing: parallel-tool-calls and claude-code-agent"
  - role_alternation failure on smoke benchmark agents
  - LLM answers about newborn gift shopping / VR headsets / Mexico trips instead of the test goal
tags:
  - benchmarks
  - context-gates
  - smoke
  - user-context
  - test-contamination
sources:
  - PR #550
repro: none-recorded
status: fixed
---

## Problem

Two of five smoke benchmarks (`parallel-tool-calls` and `claude-code-agent`) were
failing with `role_alternation` errors. The benchmark tasks are objective,
self-contained prompts, but the model's output was about the operator's personal
life — newborn gift shopping, VR headsets, Mexico trips — none of which appears
in any smoke task definition.

## Diagnosis

The smoke agents were created with Andy's real production `user_id`. That made
`get_user_context` inject the full personal context block into the system prompt:
recent communications (200 messages / 24h) and the contacts network. Those
chunks are the two heaviest in the prompt and they dominated the short objective
test goal, so the model answered the ambient conversation instead of the task.
The `role_alternation` error was the downstream symptom of the derailed
conversation, not the cause.

First bad boundary: agent creation for smoke tests passed no `context_gates`, so
every personal-context section defaulted on. The deeper owned cause is that the
harness had no notion of "this agent must run context-free" — objectivity of a
benchmark depended on which user id happened to be used.

## Solution

All five smoke tests now pass `context_gates` with every user-context section set
to `false`, so no personal data can reach a benchmark prompt regardless of which
user id creates the agent. This also removes a whole class of nondeterminism:
benchmark outcomes no longer move when the operator's inbox or contact list
changes.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark or test agent produces output about topics absent from its
prompt, suspect injected user context before suspecting the model — gate every
personal-context section off for objective tasks.
