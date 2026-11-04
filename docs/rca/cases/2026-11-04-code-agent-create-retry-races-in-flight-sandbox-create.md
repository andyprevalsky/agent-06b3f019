---
id: 2026-11-04-code-agent-create-retry-races-in-flight-sandbox-create
date: 2026-11-04
title: A code-agent session-create retry after the 60s client timeout can race the still-running first create (open)
surface: cross
component: spawn-claude-code-agent
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/domains/spawn_claude_code_agent/repo.py create_e2b_session (60s client timeout, no create-request id) against back-end acquireCodeSessionSandbox, which records a new session's sandbox only after create
symptoms:
  - two E2B sandboxes for one code session after a slow create
  - "Failed to create code session" ReadTimeout then a second sandbox starts the same goal
  - old ws-server stopped on a resumed sandbox right after a create timeout
tags:
  - claude-code
  - e2b
  - sandbox-leak
  - temporal-retry
sources:
  - commit 28a7bfc99
repro: none (not reproduced)
status: open
---

## Problem

`create_e2b_session` uses a 60s httpx timeout and sends no create-request id.
If the backend create outlives it (sandbox create retries, checkpoint restore),
the activity raises and Temporal retries with the same `lease_owner`, which
resolves to the same code session. For a new session whose sandbox is not yet
recorded, `acquireCodeSessionSandbox` creates a second sandbox; the first
create later finishes and starts a CLI on the same goal and branch with no
activity attached. For a session whose sandbox was already recorded, the retry
connects and `stopStaleWsServer` kills the first create's ws-server and CLI.
The brief's "1/2/4/8s backoff" is Temporal's default retry interval; there is
no createRequestId adoption path in agents or back-end.

## Diagnosis

Preliminary findings from code only (back-end
src/providers/e2bCodeSessionSandbox.ts acquireCodeSessionSandbox /
recordNewSandbox, src/providers/codeSessions/spawn.ts createWithCodeSession).
Not reproduced locally: a faithful repro needs the backend create route with a
delayed E2B mock. With the T5 error-budget fix, a ~5-minute outage still spends
the 5-error budget (5 x 60s), which is the intended bound for errors the
activity raises.

## Solution

Not implemented (outside the T5 owned files). Proposed: an idempotent create
keyed by a per-attempt-stable create-request id persisted on the code session
row before the sandbox create; a retry with the same id adopts the in-flight or
finished create instead of creating or stopping one.

## Human feedback

None recorded.

## Reusable lesson

A client-side timeout on a non-idempotent create must be paired with a request
id the server adopts; otherwise every retry can double the resource.
