---
id: 2026-11-04-long-wait-guidance-pointed-at-hourly-polling
date: 2026-11-04
title: Long-wait guidance for multi-day code agents pointed planners at hourly polling and quick retries, and the planner prompt claimed a 10-minute code-agent lifetime
surface: agents
component: wait-for
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/wait_for_bounds.py WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR "To wait longer, call wait_for again when it returns." while until_timestamp waits up to 31 days and wake early on agent notifications
symptoms:
  - "timeout_seconds must be at most 3600 (1 hour). To wait longer, call wait_for again when it returns."
  - "spawn_code_agent has a 10 min lifetime."
  - "Wait duration must be between 1 and 3600 seconds"
  - "a retry before that stays paused and starts nothing."
  - sub-agent supervising a multi-hour code agent ran out of iterations
tags:
  - wait-for
  - code-agents
  - usage-limit
  - multi-day
  - prompts
sources:
  - commit 4317820584 (fix)
repro: agents/tests/blackbox/wait_for.blackbox.py test_wait_for_multi_day_timestamp_wakes_when_a_background_agent_finishes
status: fixed
---

## Problem

A parent supervising a multi-day code agent had only hourly waits on offer:
wait_for(agents) caps at 3600s (default 600) and its error said "call wait_for
again", one planner iteration per wake (sub-agents have 25). Usage-limit
results named the reset time but no way to wait for it, and an immediate retry
with nothing leasable returns at once. The planner prompt said "spawn_code_agent
has a 10 min lifetime", false since C11 (CODE_AGENT_ACTIVITY_NO_DEADLINE). The
internal wait_seconds helper claimed a 3600s maximum while MAX_WAIT is 31 days.

## Diagnosis

The harness already has the right primitive: wait_for(until_timestamp) up to
MAX_WAIT_SECONDS (31 days) ends early on GENERAL_WAKE_KINDS (user message,
agent message, agent notification). No text pointed at it. Repro:
`python scripts/run_blackbox_tests.py wait_for`, pre-fix `AssertionError:
timeout_seconds must be at most 3600 (1 hour). To wait longer, call wait_for
again when it returns.`; wait_seconds pre-fix `Wait duration must be between 1
and 3600 seconds (got 2678401)`.

Step 5b climb (prompt/tool text). Class C: guidance for a long wait names the
polling path. C+1: the harness lacks a primitive to wait for an event without
spending turns. Tried: it is not missing (timestamp waits wake on
notifications), so C+1 collapses back to "the texts do not name it". C+2 (an
automatic wake at the usage-limit reset) would inject a synthetic planner turn,
which rule 25a forbids; rejected. Raising the agents-mode cap is a bound bump
(rule 25) and diverges from Codex's 1-hour wait_agent cap; rejected.

## Solution

The cap error and the timeout_seconds description point to one until_timestamp
wait that ends when a background agent finishes or messages; usage-limit retry
texts say to wait with wait_for(until_timestamp=<reset>) first; the false
lifetime line is deleted; wait_seconds derives its bounds text from
MIN_WAIT/MAX_WAIT. 10k agents: fewer planner wakes per supervised agent (one
per notification instead of one per hour).

Golden reference: codex/codex-rs/core/src/config/mod.rs
DEFAULT_MULTI_AGENT_V2_MAX_WAIT_TIMEOUT_MS = 3600*1000 (same 1-hour cap);
Claude Code background tasks notify on completion rather than being polled.

## Human feedback

None recorded.

## Reusable lesson

When a bounded wait tells the model how to wait longer, name the event-driven wait the harness already has, not a polling loop.
