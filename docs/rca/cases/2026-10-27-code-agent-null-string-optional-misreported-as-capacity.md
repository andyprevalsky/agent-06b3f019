---
id: 2026-10-27-code-agent-null-string-optional-misreported-as-capacity
date: 2026-10-27
title: Literal "null" strings for omitted optional spawn args reached code-session create, and the 500 was reported as sandbox capacity
surface: cross
component: spawn_claude_code_agent handler + back-end claude-code/codex-code create routes
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end /create routes returned 500 for a zod validation failure, and agents handler _is_recoverable_sandbox_infra_failure matched any "Failed to create code session" as capacity
symptoms:
  - "Invalid GitHub URL format: null"
  - "HTTP 500: [zod invalid_string 'Invalid uuid' path code_session_id]"
  - "Code session could not start due to a transient sandbox capacity error"
tags:
  - spawn-agent
  - code-agent
  - null-string
  - error-classification
sources:
  - agent 942d8562-30c5-491b-a34d-99713b2ac753 (2026-10-27 22:32-22:33 UTC, rose-1-flash qwen-3.8-27b)
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py (cc_exec_invalid_code_session_id_not_sent, cc_validation_failure_not_capacity); back-end/src/tests/blackbox/claude-code.blackbox.ts (non-uuid code_session_id -> 400)
status: mitigated
---

## Problem

Root 942d8562 spawned code agents twice with failures. The persisted spawn_agent
tool_calls show `github_repo_link`, `code_session_id`, `start_url`, `items_csv`
as the JSON STRING "null" (jsonb_typeof = string), not JSON null. The handler
forwards any truthy value, so the backend saw `github_repo_url: "null"`
(403 GITHUB_ACCESS_DENIED, "Invalid GitHub URL format: null") and
`code_session_id: "null"` (zod uuid failure surfaced as HTTP 500).

## Diagnosis

Model-emitted "null" strings -> `_spawn_code` truthy forward -> create route.
The create routes let ZodError fall into the generic 500 handler, and the agent
marker list contained the bare "FAILED TO CREATE CODE SESSION", so every create
failure (any status) was told "transient sandbox capacity error". The model
also emits "null" strings plausibly because the Cerebras projection collapses
Optional params to plain string (see 2026-10-24 union-typed case); that
upstream tool-arg normalization is owned by a separate worker and not changed here.

## Solution

- back-end claude-code and codex-code create routes: ZodError -> HTTP 400
  INVALID_REQUEST naming the failing paths.
- agents handler: a non-UUID code_session_id is rejected up front with a
  truthful soft-fail message and no session create; the bare create-failure
  marker now requires HTTP 5xx.
- Not fixed here: github_repo_link "null" still reaches the backend and yields a
  truthful 403 soft-fail; generic "null" string normalization belongs to the
  spawn_agent tool-arg validation work.
10k agents: per-call validation only, no shared state.

## Human feedback

None recorded.

## Reusable lesson

Reject malformed model-supplied identifiers at the tool boundary and return 4xx for validation failures, so they are never mistaken for retryable infrastructure flakes.
