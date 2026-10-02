---
id: 2026-10-01-claude-code-sandbox-orphaned-when-no-attempt-reattaches
date: 2026-10-01
title: Claude Code sandboxes stayed running after a terminate, cutover, or final-attempt timeout because nothing would ever reattach
surface: cross
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py cancel handling, which kept the sandbox for a retry on every non-requested cancel even when no retry would come
symptoms:
  - code sandbox still ACTIVE after the agent workflow was replaced
  - old Claude Code CLI keeps pushing next to the replacement run
  - E2B sandbox runs until its own timeout after the agent failed
tags:
  - claude-code
  - e2b
  - sandbox-leak
  - deploy-cutover
  - temporal-retry
sources:
  - agent 3efa7cae-8051-4efd-9c49-d09f65b6e22e
  - PR #1354
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py
status: fixed
---

## Problem

The deploy-resume fix made a Claude Code activity keep its sandbox on any cancel
the user did not request, so a retry could reattach. An adversarial review found
four cases where no attempt ever reattaches, so the sandbox, and the CLI working
in it, kept running until E2B's own timeout:

- the workflow was terminated (Temporal delivers a `not_found` cancel);
- the activity was reset;
- the last attempt the retry policy allowed timed out;
- a backend deploy cutover replaced the workflow from durable state.

A pause landing during the reattach probe also found no `task_id` to close. A
new sandbox could also leak if anything failed before its session reached the
heartbeat details. On the unfixed backend, a cutover left the agent's
`ClaudeCodeSession` at `status=ACTIVE closedAt=null`.

## Diagnosis

The activity decided "keep the sandbox" from the cancel type alone. Whether
anyone will reattach depends on `ActivityCancellationDetails` (`not_found`,
`reset`, `paused`) and on `activity.info().attempt` against the retry policy's
`maximum_attempts`. The workflow only sees an `ActivityError` after retries are
exhausted, so it never learned which sandbox the final attempt held. The backend
cutover released browser sessions only, though code sandboxes are activity-owned
the same way. The deepest owned cause is that sandbox ownership after a cancel
was inferred locally instead of from who could still reattach.

## Solution

- `_next_attempt_reattaches` closes the sandbox unless a later attempt (or a
  resumed pause) will reattach. `task_id` is set before the reattach probe. A new
  session rides the heartbeat details before anything else can fail.
- The manager reads the timed-out attempt's `last_heartbeat_details` (decoded as
  a list) and runs `close_detached_code_session_activity` for that session.
- The backend helper `releaseTerminatedWorkflowResources` releases browser
  sessions and code sandboxes in the cutover (`sealClaimedReplacement`) and in
  descendant cleanup. Cemented by the cutover blackbox cases for the root agent
  and for a descendant.

10k agents: one indexed query and one kill per sandbox owned by the one agent
being terminated. No per-tick work.

Residuals: a reattach does not extend the E2B sandbox timeout. That is bounded
because `MAX_RUNTIME_S` counts from `loop_started_at` across reattaches and
equals `SANDBOX_TIMEOUT_MS` (30 min). But the sandbox is created before that
clock starts, so a session that uses its whole runtime budget can lose its
sandbox in the final seconds. Code sandboxes of agents sealed by the liveness
reconciler rely on the activity's own `not_found` close or the E2B timeout.

## Human feedback

None recorded.

## Reusable lesson

Before keeping a resource for a retry, prove a retry will run: check the
cancellation reason and the remaining attempts, and have the last owner (the
workflow or the cutover) release it otherwise.
