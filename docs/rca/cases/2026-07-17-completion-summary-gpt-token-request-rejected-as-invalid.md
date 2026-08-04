---
id: 2026-07-17-completion-summary-gpt-token-request-rejected-as-invalid
date: 2026-07-17
title: The completion_summary call used a GPT token and Rose rejected it as invalid_request at every level of the tree
surface: agents
component: completion-summary
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: completion_summary LLM call — issued with token_type gpt and rejected by Rose as invalid_request
symptoms:
  - '{"call_site":"completion_summary","token_type":"gpt","reason":"RoseInvalidRequest","token_error":"invalid_request"}'
  - '"🔴 ACTION REQUIRED … STUCK" — attempt_completion stuck IN_PROGRESS'
  - completion takes minutes even for a one-word answer
tags:
  - completion-summary
  - rose
  - compute-token
  - gpt
  - prod
sources:
  - memory:project_prod_agent_runaway_spawn_completion_summary
  - agent 39cd4564
repro: none-recorded
status: open
---

## Problem

On a manual prod probe (goal "What is 2+2?", agent `39cd4564`), the
`completion_summary` LLM call failed at **every level** of the sub-agent tree with
`{"call_site":"completion_summary","token_type":"gpt","reason":"RoseInvalidRequest","token_error":"invalid_request"}`.
`attempt_completion` was simultaneously stuck IN_PROGRESS on multiple calls,
logging "🔴 ACTION REQUIRED … STUCK". The agent did eventually complete, but only
after minutes.

## Diagnosis

Found with `agent_logs.py <id> --tree --diagnostics --prod`. The
`completion_summary` call site requests a **gpt** compute token, and Rose rejects
the resulting request as `invalid_request` — so the failure is deterministic and
reproduces at every level rather than being a transient provider error. The open
question recorded is whether the request itself is malformed for that provider or
whether the token/config selection for this call site is wrong; either way the
completion path retries and stalls instead of degrading cleanly, which is what
turned a per-call failure into multi-minute completions and stuck
`attempt_completion` states.

The backend was healthy (201 on create with a `temporal_workflow_id`, 200 on
list, 200 on the compute-token heartbeat), so this is an agent-runtime defect.

## Solution

Not fixed in the recorded session. Candidate work identified: determine why
`completion_summary` uses a gpt token that yields `RoseInvalidRequest` (malformed
request vs token/config selection), and fix the `attempt_completion` stuck-verifier
so a failing summary call cannot leave completion hanging. Classified as prod
agent-runtime degradation and escalated as a separate effort from the FE PR in
flight.

## Human feedback

The user's precedent of escalating a pre-existing prod failure rather than blocking
or hacking the in-flight PR was followed here: PR #777 shipped with all owned gates
green and this incident was raised separately.

## Reusable lesson

A per-call-site LLM failure that repeats identically at every level of an agent
tree is a request/token-selection contract bug, not a transient provider error —
read the `call_site` and `token_type` in the failure log before retrying.
