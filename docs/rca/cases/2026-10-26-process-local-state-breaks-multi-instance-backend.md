---
id: 2026-10-26-process-local-state-breaks-multi-instance-backend
date: 2026-10-26
title: Process-local maps, locks and cron claims broke the backend on a second Render instance
surface: back-end
component: shared-state
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src module-level Maps and promise chains (agentcard/store.ts pending, supervisorHandler.ts commitLocksByUser, whatsapp RECENT_MESSAGE_IDS, compute-grants pending) and non-atomic cron claims (gmailSync.ts, service.plaidTransactions.ts)
symptoms:
  - "Unknown or expired OAuth state"
  - "AgentCard token request failed (invalid_grant)"
  - "commits overlapped: second entered"
  - connect modal poll returns state unknown after a load-balancer hop
  - Gmail and Plaid sync run twice for the same integration
tags:
  - multi-instance
  - scale-out
  - shared-state
  - render
  - cron
sources:
  - memory:scalability-audit-100-seats-20261024.md
repro: back-end/src/tests/blackbox/multi-instance.blackbox.ts (two Node processes, one local Postgres)
status: fixed
---

## Problem

Prod runs one Node process on one Render instance (`numInstances: 1`,
`pro_max`, no autoscaling): a single point of failure, and every deploy is a
cutover. Running a second instance was unsafe because request and job state
lived in process memory or relied on non-atomic claims. The 2026-10-24 audit
named the AgentCard PKCE map, compute connect sessions, the per-user SMS commit
lock and Gmail/Plaid crons. A sweep of `back-end/src` on 2026-10-26 found 15
class-A sites.

The repro is `multi-instance.blackbox.ts`. It runs the real module code in two
Node processes against one local database. On main (with only a refactor that
exported the existing functions), every case failed:

- PKCE: "instance B must find the PKCE state instance A stored". The callback
  on B throws "Unknown or expired OAuth state".
- SMS lock: "commits overlapped: second entered 1497ms before first left".
- WhatsApp: a redelivery on the other instance was not a duplicate (0 of 2).
- Gmail: "exactly one instance may sync the integration, got 2".
- Plaid: "exactly one instance may sync the item, got 2".
- AgentCard refresh: "AgentCard token request failed (invalid_grant)". The
  refresh token rotates on use, and both instances spent it.
- Connect session: B polled `{"state":"unknown"}`, and its cancel never reached
  A's live browser, which kept billing.

## Diagnosis

Each site assumed a single process: a module-level Map, Set or promise chain
was the source of truth for a flow, a lock or a dedupe. Gmail's "claim" was an
unconditional `update` after a `findMany`. Plaid had no claim at all, and cron
and webhook syncs could also overlap on one instance. The class is shared
coordination state held per process. Postgres is the only store every instance
shares, and the repo already had one instance of the right pattern (the
proactive-SMS advisory-locked lease). It was not generalized.

## Solution

- `providers/sharedState.ts` (new), backed by the `SharedEphemeralState` table
  (migration `20261026210000_shared_ephemeral_state`, RLS enabled, writers
  reap expired rows in batches):
  - `putEphemeral` / `getEphemeral` / `takeEphemeral`: atomic single-use via
    `DELETE ... RETURNING`.
  - `acquireLease` / `releaseLease`: `INSERT ... ON CONFLICT DO UPDATE WHERE
    expired`, owner-token release.
  - `withSerializedLock`: `pg_advisory_xact_lock` through
    `runTransactionWithRetry`.
- Call sites:
  - PKCE → ephemeral put/take, 10-minute TTL.
  - SMS commit lock → per-user advisory lock.
  - WhatsApp dedupe → lease per wamid, 24 h.
  - Gmail → atomic `updateMany` claim (only while still due) plus an
    in-process overlap guard.
  - Plaid → per-item lease (15 min) shared by cron and webhook, plus an overlap
    guard.
  - AgentCard refresh → per-user advisory lock, then a re-read that reuses a
    token another instance rotated.
  - Compute connect sessions → the owner mirrors its poll snapshot each second
    and applies cancel requests that other instances file (the browser and CDP
    socket can only live on the owner).
- 10k agents: one row or lock per flow, user or item. Cost scales with the work
  coordinated, not with instances or agents. No per-request cross-instance
  fan-in. The connect mirror writes one row per live connect session per
  second.
- Not fixed here (still unsafe at N>1; listed in the PR):
  - local-device hub WebSockets and relays (`localDevices/hub.ts`), project
    workspace executors and local Claude Code child processes — these need
    instance affinity or a shared relay;
  - SMS `/clear` abort of a run on another instance;
  - identity inbox mints, compute grant re-mint, Steel in-flight set, Browser
    Use profile single-flight;
  - demo-cache proxy trace ordinals.
- Golden reference: `claude-code-src` and `codex` are single-process CLIs with
  no multi-instance coordination analog. Searched for advisory/lease/lock
  patterns; none apply. The fix follows this repo's own proactive-SMS lease
  (`providers/smsSupervisor/proactiveOutreach.ts`).

## Human feedback

Parent: do not turn on a second Render instance or autoscaling (spend). Report
it as an approval item with the exact setting and pool math. Andy: no breach
or exposure forensics; contain and fix only.

## Reusable lesson

Never let a module-level Map, Set or promise chain be the source of truth for a flow, lock, dedupe or job claim on the backend; put it in Postgres keyed per flow so any instance can complete it.
