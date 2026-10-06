---
id: 2026-10-01-steel-session-lifetime-shorter-than-browser-activity
date: 2026-10-01
title: Steel released browser sessions mid-task because their lifetime was shorter than the browser activity driving them
surface: cross
component: steel-session-lifetime
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel — every Steel session create site hardcoded a 15-minute timeout while the browser activity is allowed 30 minutes
symptoms:
  - Reconnection failed - CDP still not connected
  - browser run loses CDP exactly 15 minutes after the Steel session started
  - steel_session_expired
  - browser_session_expiring
tags:
  - steel
  - browser-agent
  - cdp
  - session-lifetime
  - deploy-resume
sources:
  - agent 3efa7cae-8051-4efd-9c49-d09f65b6e22e
  - commit 875c14774
  - PR #1354
repro: back-end/src/tests/unit/steel-session-lifetime.test.ts
status: fixed
---

## Problem

On prod agent 3efa7cae, four browser runs died with `Reconnection failed - CDP
still not connected`. Each one lost CDP exactly 15 minutes after its Steel
session was created, while the browser activity
(`spawn_browser_agent_v3/config.py` `ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES`)
was still allowed to run for 30.

A sibling path had the same contract gap. A resumed or retried browser activity
gets a fresh 30-minute budget but may reattach to a session an earlier invocation
created. The backend reported `same_session_available: true` for any session
with `ttlMs > 0`. A live repro with a real Steel session created with a 3-minute
lifetime got `same_session_available=true ttl_ms=179590` on the unfixed code,
and the step loop kept stepping on it (57 steps in the blackbox repro) until the
provider released it.

## Diagnosis

Steel's `timeout` is an absolute lifetime: the provider releases the session when
it elapses even while a CDP client is attached. The three Steel create sites
(`createSessionWithContext`, session recovery, resume/rotate) each passed a
literal `15 * 60_000`. Nothing tied that literal to the Python activity budget,
so when the budget grew to 30 minutes (and scales with `BROWSER_MAX_ITERATIONS`)
the session lifetime silently fell below it. The deepest owned cause is two
copies of one contract, the browser run's time budget, held in two languages
with no parity check. The reuse path had the same gap: the reuse check asked
"is the session still alive?" when the real question was "will it outlive the
next step plus teardown?".

## Solution

- `back-end/src/providers/steel/sessionLifetime.ts` derives the session lifetime
  from the activity budget plus 5 minutes of teardown, capped at Steel's 60-minute
  plan maximum. Every create site calls `steelSessionTimeoutMs()`. The unit test
  checks parity with the Python budget constants and fails on any literal
  `timeout:` at a create site.
- Reuse: `sameSessionAvailability` (`service.task-info.ts`) refuses to reuse a
  session with less than `BROWSER_SESSION_MIN_REMAINING_MS` (7 minutes: one
  supervised step at 330s plus the 45s recording finalize and 20s disconnect).
  It reports `steel_session_expiring`, so the resume creates a replacement on the
  same profile at the saved URL.
- The browser step loop records the reused session's deadline. At a step
  boundary, if less than `BROWSER_SESSION_MIN_REMAINING_SECONDS` remains, it
  yields with `browser_session_expiring` through the existing deploy-drain resume
  path. The manager then restarts the task at that step on a replacement session.
  A parity test pins the TypeScript and Python thresholds together.

10k agents: no new queries. The reuse check uses the health read the resume
already makes, and the deadline is one monotonic comparison per step.

Residual: a task whose budget, scaled with `BROWSER_MAX_ITERATIONS`, exceeds 55
minutes is capped at Steel's 60-minute plan limit. Steel 0.16 has no extend API.
A fresh session in that configuration can still expire before the activity ends.

## Human feedback

The user asked for this as one of three browser failures on agent 3efa7cae
("CDP issue") to be fixed via /RCA.

## Reusable lesson

When a provider resource has an absolute lifetime, derive it from the budget of
whatever drives it, and check "outlives the next unit of work" rather than
"still alive" before reusing it.
