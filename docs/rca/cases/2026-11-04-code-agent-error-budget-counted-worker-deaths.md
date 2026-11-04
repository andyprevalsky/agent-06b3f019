---
id: 2026-11-04-code-agent-error-budget-counted-worker-deaths
date: 2026-11-04
title: The code-agent activity's 5-error retry budget counted worker deaths, so a multi-day run ended on an ordinary network blip
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _raise_bounded_activity_error, which compared activity.info().attempt (incremented by heartbeat-timeout retries after a dead worker) against CODE_AGENT_ERROR_RETRY_LIMIT
symptoms:
  - code agent fails non-retryable after only 2-3 errors on a long run
  - "WebSocket connection to Claude Code sandbox lost after all reconnect attempts" ends a multi-day code session
  - ApplicationError non_retryable=True from spawn_claude_code_activity after worker OOM or deploy restarts
tags:
  - claude-code
  - codex
  - temporal-retry
  - multi-day
  - heartbeat
sources:
  - commit 28a7bfc99
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_claude_code_error_budget_ignores_worker_deaths
status: fixed
---

## Problem

The code-agent activity runs with unlimited Temporal retries so worker crashes
and deploys never end a session; errors the activity itself raises were meant
to stop after `CODE_AGENT_ERROR_RETRY_LIMIT` (5) attempts. The check read
`activity.info().attempt`, which Temporal also increments for every
heartbeat-timeout retry after a worker death (OOM, SIGKILL, deploy). A weekend
run with two worker deaths and two network blips turned the third blip into a
non-retryable failure.

Local repro (ActivityEnvironment, two attempts that died before heartbeating,
then a transient `HTTP 502` from session create on every later attempt, each
attempt fed the previous attempt's last heartbeat):
`cd agents && python scripts/run_blackbox_tests.py spawn-claude-code-agent`
(test `cc_error_budget_ignores_worker_deaths`). Pre-fix:
`final flags per error=[False, False, True, True, True]` (the 3rd error was
final). Post-fix: `[False, False, False, False, True]`.

## Diagnosis

1. The non-retryable decision used the attempt number (service.py:3204-3220 at
   28a7bfc99).
2. The attempt number counts every Temporal attempt, including heartbeat
   timeouts that raise nothing in the activity; the config comment already
   promised "Errors the activity itself raises (not worker death)".
3. Nothing carried a count of the activity's own errors across attempts. The
   only state that survives an attempt is the heartbeat details, which already
   carry the reattachable session (2026-10-01 case).

No runtime log was available for a real multi-day run (review lead); the
mechanism is proven with the production activity under Temporal's
ActivityEnvironment.

Assumption recorded: Temporal flushes the last heartbeat details with an
activity failure (the SDK awaits the pending heartbeat task before completing).
The count also rides on every regular heartbeat, so a lost final beat can only
undercount the last error, never reset the budget.

## Solution

Every heartbeat of the activity carries `{"code_agent_errors": n}` (outer
`heartbeat_resume_details` context entered before anything can heartbeat; the
session context carries it too). The generic error path increments `n`; the
error becomes non-retryable when `n >= CODE_AGENT_ERROR_RETRY_LIMIT`
(`_bounded_activity_error`). Worker deaths raise nothing and never count. A
drain yield still starts a new activity (count 0), as before.

10k agents: one small int in each activity's heartbeat details; no extra
queries, rows or calls.

## Human feedback

None recorded.

## Reusable lesson

A retry budget for "errors we raised" must count those errors in state that
survives attempts (heartbeat details), never Temporal's attempt number, which
also counts worker deaths.
