---
id: 2026-10-27-trajectory-agent-upsert-locked-every-message-write
date: 2026-10-27
title: The per-agent AgentTrajectoryAgent upsert locked the agent row on every message write, so one open message transaction blocked all other message writes for that agent
surface: back-end
component: trajectory-search
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/prisma/migrations/20261026210002_agent_trajectory_agent sync_agent_trajectory_search(): INSERT ... ON CONFLICT (agentId) DO UPDATE ... WHERE <changed> locks the conflicting AgentTrajectoryAgent row even when the WHERE skips the update"
symptoms:
  - "Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms"
  - "canceling statement due to lock timeout ... while locking tuple ... in relation \"AgentTrajectoryAgent\""
  - browser-user-pause-race.test.ts B3 failed after syncing main 738841676
tags:
  - trajectory-search
  - row-lock
  - 10k-agents
  - agent-trajectory-agent
sources:
  - deploy/polar-stack-integration backend coverage 2026-10-27 (unit phase, browser-user-pause-race.test.ts)
  - 2026-10-26-trajectory-search-copied-agent-goal-onto-every-row
repro: back-end/src/tests/unit/agent-trajectory-agent-lock.test.ts
status: fixed
---

## Problem

After main gained the per-agent `AgentTrajectoryAgent` table (#1586), the deploy branch's `browser-user-pause-race.test.ts` failed. Its B3 case holds a pause-annotation transaction open while a second session commits a newer message for the same agent. That second `Message` insert waited about 5 s for a row lock, until Prisma expired the held transaction.

## Diagnosis

`sync_agent_trajectory_search()` fires `AFTER INSERT OR UPDATE OF text, role, "agentId", "createdAt"` on `Message`. On every call it ran `INSERT INTO "AgentTrajectoryAgent" ... ON CONFLICT ("agentId") DO UPDATE ... WHERE <goal/title changed>`. PostgreSQL locks the conflicting row for `ON CONFLICT DO UPDATE` even when the `WHERE` clause skips the update. So any transaction that wrote one message for an agent held that agent's row until it committed, and every other message write for the agent queued behind it. Each write also dirtied the row's page to record the lock.

Repro: two `psql` sessions on a local DB with main's trigger. Session 1 updates a message's text and holds the transaction. Session 2's same-agent insert with `lock_timeout = 1500ms` failed with `canceling statement due to lock timeout ... while locking tuple (18,75) in relation "AgentTrajectoryAgent"`. The new unit regression failed the same way (55P03).

## Solution

Migration `20261027020000_agent_trajectory_agent_skip_unchanged_lock` replaces the function. It first runs a non-locking `NOT EXISTS` check for a row with the same owner and an identical goal/title, and runs the unchanged upsert only when that check fails. Results are the same as before: a missing row is inserted, a changed goal/title is updated, and a different owner is never overwritten. The difference is that the steady state takes no row lock. Two first writers racing still meet `ON CONFLICT` exactly as before. The local runtime SQL hook applies the new migration after `20261026210002`.

Verification: `agent-trajectory-agent-lock.test.ts` failed before the fix and passes after it, 5 consecutive passes. The SQL two-session repro passes. `browser-user-pause-race.test.ts` (B3) passes. `coverage-script.test.ts` asserts the hook order.

At 10,000 agents: no per-agent row lock or page write on ordinary message writes. The lock and write happen only when an agent's goal or title actually changes.
