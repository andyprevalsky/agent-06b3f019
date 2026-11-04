---
id: 2026-11-04-code-agent-retryable-error-closed-live-sandbox
date: 2026-11-04
title: A retryable code-agent error paused the live sandbox, so the Temporal retry restarted the CLI from the original goal
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py spawn_claude_code_activity generic `except Exception` path, which posted "Task Failed" and called close_e2b_session(reason="failure") before re-raising an error Temporal would retry
symptoms:
  - "Task Failed" row followed by a new "Claude Code Started" for the same tool call
  - "[ClaudeCode] Previous sandbox unreachable; closing it before a fresh start" after a WebSocket loss
  - code agent restarts its goal with --resume after a ~60s ws outage
  - backend kills the old ws-server and a new CLI starts with the original goal
tags:
  - claude-code
  - codex
  - temporal-retry
  - reattach
  - multi-day
sources:
  - commit 28a7bfc99
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_claude_code_retryable_error_keeps_the_live_sandbox_for_the_retry
status: fixed
---

## Problem

When any non-cancel exception escaped the activity (commonly
`_handle_reconnect_exhausted` after ~60s without the sandbox WebSocket), the
generic path posted an ERROR "Task Failed" task_complete row and closed the
session (checkpoint + pause), then re-raised. Temporal retried; the retry's
reattach probe failed against the paused sandbox, so it created a new session,
the backend stopped the old ws-server, and a new CLI started with `--resume`
and the original goal. The chip showed a failure that was not final.

Local repro: the production ws-server.mjs on localhost with a scripted CLI
(`_LocalCodeSandbox`); attempt 1 loses its socket through the real
`_handle_reconnect_exhausted`; attempt 2 receives attempt 1's last heartbeat.
Pre-fix: `a retryable error must not close the live sandbox: [{'task_id':
'cc-task-1', 'code_provider': 'claude', 'reason': 'failure'}]`. Post-fix:
attempt 1 closes nothing and posts no failure, attempt 2 reattaches (1 create
total) and completes; an error with the budget spent still posts "Task Failed"
and closes with reason `failure`.

## Diagnosis

1. The error path's cleanup ran unconditionally; only
   `_raise_bounded_activity_error` (after cleanup) knew whether Temporal would
   retry.
2. The cancel path already distinguished "a retry will reattach" from "no
   attempt will run" (2026-10-01 case); the error path never got the same rule.
3. Deepest owned cause: the terminal decision (final vs retryable) was made
   after the side effects that only a terminal attempt may perform.

## Solution

Decide finality first (`_bounded_activity_error` + `_error_ends_the_run`). A
retryable error heartbeats the live session plus the error count and re-raises
without user-visible failure or close; the retry reattaches through the
existing heartbeat path. Only an error that ends the run (non-retryable, budget
spent, or not inside an activity) persists output, posts "Task Failed" and
closes the session. Sibling prevented: any retryable failure after attach
(transcript or message persistence errors, transient backend errors during the
loop) no longer restarts the CLI.

10k agents: removes one checkpoint + pause + create + CLI restart per transient
error; no added calls.

## Human feedback

None recorded.

## Reusable lesson

Decide whether an attempt is terminal before running terminal side effects;
a retryable attempt must leave every resource the retry reattaches to.
