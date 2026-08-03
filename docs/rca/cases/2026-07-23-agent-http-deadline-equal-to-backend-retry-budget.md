---
id: 2026-07-23-agent-http-deadline-equal-to-backend-retry-budget
date: 2026-07-23
title: Agent HTTP deadline equal to the backend AgentCard retry budget timed out before the call could return
surface: agents
component: spawn-browser-agent
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: the agent-side HTTP client deadline for the AgentCard company flow — it was set equal to the backend's own retry budget instead of outwaiting it
symptoms:
  - AgentCard production lifecycle timeout/recovery failure
  - spawn_browser_agent failure followed by recovery fanout
  - backend AgentCard company-flow retries reach the edge of the 60s budget and the caller gives up first
tags:
  - agentcard
  - timeout
  - browser-agent
  - temporal-activity-timeout
  - retry-budget
sources:
  - PR #866
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The AgentCard production lifecycle failed on a timeout/recovery path: the
browser-agent mint call surfaced as a `spawn_browser_agent` failure and the
workflow then fanned out recovery descendants. The failure was not a genuinely
hung dependency — the backend was still working inside its own retry budget when
the caller abandoned the request.

## Diagnosis

Three deadlines were stacked on the same call: the agent-side HTTP deadline, the
backend AgentCard company-flow retry budget (60s), and the Temporal activity
timeout (90s). The agent HTTP deadline had been set _equal_ to the backend retry
budget, so any run where backend retries extended to the edge of that 60s window
raced the client's own clock. The nested HTTP client therefore timed out before
the 90s Temporal activity had any chance to complete, and the harness read a
still-in-progress mint as a hard tool failure and started recovery fanout. The
deeper owned cause is nesting timeouts without an ordering invariant: an inner
caller's deadline must strictly outwait the budget of the thing it is waiting on
and stay strictly inside the outer activity timeout, otherwise the middle layer's
legitimate retries are indistinguishable from a hang. Compounding the cost, the
benchmark harness collected logs and ran cleanup while the timed-out/stalled
agent and its recovery descendants were still running, so they kept spending
during evidence gathering.

## Solution

Widened the agent HTTP timeout so it outwaits the backend AgentCard retry budget
while remaining inside the Temporal activity timeout, giving an explicit
inner < middle < outer ordering, and added blackbox coverage for that timeout
ordering. The benchmark harness now pauses timed-out/stalled agents _before_ the
expensive cleanup and log-collection phase so recovery descendants stop spending
while the harness gathers evidence. The ordering invariant generalizes to every
nested-deadline call site (tool HTTP client → backend retry loop → Temporal
activity).

## Human feedback

None recorded.

## Reusable lesson

When deadlines nest, make each outer wait strictly longer than the budget it
wraps — an inner timeout equal to the callee's retry budget converts normal
retries into a false tool failure and triggers recovery fanout.
