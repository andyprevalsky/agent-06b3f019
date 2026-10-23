---
id: 2026-10-23-mass-agent-guest-backend-db-latency-floor
date: 2026-10-23
title: test-mass-agent-run-0 cloud guest backend serves every Prisma query at a ~300 ms p50 floor under the 51-agent tree, so autoscaled workers time out backend calls and the root misses 900s
surface: infra
component: cloudbench-guest-backend
classification: unresolved
problem_class: concurrency-inefficiency
first_bad_boundary: cloud guest back-end (Express/Prisma against the guest's Postgres) under the test-mass-agent-run-0 tree — trivial Agent.findUnique p50 240-320 ms, HTTP GET /api/agents/:id p50 1.1-2.5 s, p99 9-29 s, in every heavy copy of run 1 (cbbf3dd0c) and run 2 (8b69d3760); exact cause (pool queueing vs guest CPU vs PG contention) not yet isolated
symptoms:
  - "Timeout after 926s (task timeout=900s)"
  - "Activity timeout (attempt 1/3)" func=post_agent_message timeout=30.0
  - "Child terminal reconciliation failed" error="Activity task timed out"
  - "Failed to save explore message"
  - "ERROR - ReadTimeout:"
tags:
  - test-mass-agent-run-0
  - mass-agent
  - cloudbench
  - autoscaler
  - backend-latency
  - descend-full69-20261023
sources:
  - fleet run original600-1792738962466034914
  - fleet run original600-1792722242636117810
  - agent 23de63bf-4f55-49c5-9220-c000cfbddcc1
  - agent b9ecdf7f-4c77-4b15-b440-84bd42d4d3b6
  - agent a9321ffb-9442-4d5b-ad38-da928a3f4a1b
  - commit 55c90637b
repro: none yet — open observability gap (no guest DB pool / CPU / pg_stat_activity capture)
status: open
---

## Problem

The task test-mass-agent-run-0 failed in every cloud copy of both descend-full69
outcome runs. Run 1 (cbbf3dd0c, before K5) failed 2/2 copies on the 900 s
timeout. Run 2 (8b69d3760, with K5 and K9) failed 5/5 copies:

- r004-j0030 timed out.
- r001-j0003 and r002-j0012 went INFRA. Attempt 1 ran a real agent, but the
  runner recorded `ERROR - ReadTimeout:` against the guest backend. The campaign
  retried, and the retry got a Hub 409. That is the K7 chain; K7's Hub half is
  still waiting on a prod deploy.
- r003-j0021 hit batch spawn 409 "Parent workflow generation is no longer
  current" (split; see Diagnosis).
- r005-j0039 was a root stall (split; see Diagnosis).

K5 is working as intended. Fresh worker clones ran git-fetch in 0-1 s and
git-checkout in 24-28 s, logged "worker-runtime checkout omits
agents/benchmarks/history/*.jsonl", and polled and ran workflows. However, those
autoscaled workers then logged 316-572 `post_agent_message` activity timeouts
each (30 s), plus spawn_agent StartToClose timeouts. The primary worker logged 0.

## Diagnosis

Guest backend latency is the shared first-bad observation in the heavy copies.
Measurements per copy:

| Copy | GET /api/agents/:id | POST messages p50 | Agent.findUnique p50 | ToolUsage.findMany p50 |
| --- | --- | --- | --- | --- |
| Run 1 28210 | p50 2.5 s, p99 28.7 s | 1.5 s | 245 ms | 479 ms |
| Run 2 27477 | p50 1.1 s, p99 8.4 s | 2.7 s | 253 ms | not recorded |
| Run 2 27519 | p50 2.5 s, p99 17.5 s | not recorded | 318 ms | 560 ms |

AgentTaskProgressEstimate.findMany shows a comparable per-call latency.

A light copy (27547) shows p50 7 ms for HTTP, so the floor appears only under the
tree load. The autoscaled worker's 15 s and 30 s client timeouts fire against
this latency. The primary probably avoids them through localhost and fewer
in-flight calls, but that is not proven.

The cause of the ~300 ms floor for a primary-key lookup is NOT proven. The
candidates are:

1. Prisma connection-pool queueing (connection_limit vs. in-flight requests).
2. Guest CPU saturation (backend + PG + worker + 51 agents on one machine).
3. Postgres lock or IO contention.

The run evidence has no pool wait time, CPU, or pg_stat_activity capture, so
none of these can be told apart. The RCA stays open as an observability gap.

Split members, whose own evidence shows different boundaries:

- **r003-j0021:** the backend rejected POST /api/agents/batch with 409 "Parent
  workflow generation is no longer current" (back-end/src/providers/workflowGeneration.ts).
  The root therefore made 0 spawn_agent sub-agents.
- **r005-j0039:** the root went silent for 520 s with 3 messages. Single
  requests took a long time (Cookie.findMany 25 s, POST /api/archive/agent-start
  39 s), and the tree never started.
- **r001-j0003 / r002-j0012 INFRA:** these are the K7 chain. The trigger is the
  runner ReadTimeout from this boundary.

## Solution

None yet. Next step: capture the guest backend's Prisma pool wait time, process
CPU, and `pg_stat_activity` / lock waits during the tree. Then reproduce
locally with a single-stack 51-agent spawn and observe the same floor before
changing anything. Do not raise worker or benchmark timeouts (rule 25).

10k-agent implication: per-agent backend round trips (GET /api/agents/:id
polling, per-message POSTs, progress-estimate reads) already saturate one
backend at 51 agents. The real fix must reduce per-agent request volume or the
per-request DB cost, not add timeouts.

## Human feedback

None recorded.

## Reusable lesson

When a wide tree fails only once extra workers join, measure the shared backend's per-query latency floor before blaming the workers or their checkout.
