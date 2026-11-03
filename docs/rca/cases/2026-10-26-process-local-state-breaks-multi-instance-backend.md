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
  - "creates overlapped across instances" (E2B Claude Code creates, "redis: connection pool timeout")
  - "Unique constraint failed on the fields" at boot catalog seed / x402 first payment (P2002)
  - each #errors alert posted once per backend instance; messaging upload part attempts 2
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
  (migration `20261027013000_shared_ephemeral_state`, RLS enabled, writers
  reap expired rows in batches):
  - `putEphemeral` / `getEphemeral` / `takeEphemeral`: atomic single-use via
    `DELETE ... RETURNING`.
  - `acquireLease` / `releaseLease`: `INSERT ... ON CONFLICT DO UPDATE WHERE
    expired`, owner-token release.
  - `renewLease`.
  - `withSerializedLock`: a lease row renewed by a heartbeat, with waiters
    polling at capped backoff. The first version held an interactive
    transaction carrying `pg_advisory_xact_lock`, which pinned a pooled
    connection per holder and per waiter through slow outside calls (Twilio
    send, AgentCard HTTP). A 120s timeout also silently broke exclusion. With
    Supavisor `pool_size=60`, about 60 contended commits would stall the
    fleet, so the adversarial review rejected it.
- Call sites:
  - PKCE → ephemeral put/take, 10-minute TTL.
  - SMS commit lock → per-user lease lock.
  - WhatsApp dedupe → lease per wamid: 10 minutes while the message is
    handled, 24 h once handled, so a crash mid-handling lets Meta's retry
    through.
  - Gmail → atomic `updateMany` claim (only while still due) plus an
    in-process overlap guard.
  - Plaid → per-item lease (15 min) shared by cron and webhook. A sync skipped
    because the lease is held files a resync request the holder honors. Plus
    an overlap guard.
  - Gmail and Plaid overlap guards expire after one hour, so a hung run cannot
    stop a sync.
  - AgentCard refresh → per-user lease lock, then a re-read that reuses a
    token another instance rotated. A forced refresh compares against the
    token that actually got the 401.
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

### 2026-10-28 recurrence: lane S26 (N=2 low-severity sweep)

Five more single-process assumptions turned up before scaling prod from 1 to 2
instances. Each one now has a two-process case in `multi-instance.blackbox.ts`.
All five failed on the unchanged main (`cbe2ed413`) and pass after the fix
(24/24, then 5 consecutive runs):

- `providers/e2bCreateSlot.ts`: the per-process promise chain serialized creates
  only within one instance (`creates overlapped across instances`). It now keeps
  the per-process queue (one waiter per instance polls) in front of
  `withSerializedLock('e2b-claude-code-create', 15 min wait)`. #1615's
  capacity fail-fast still propagates from inside the slot.
- `uploadService.messagingJobs.ts`: a part's 10-minute claim was never renewed,
  so a slow part was reclaimed and re-run by another drain (`attempts 2`).
  `holdPartClaim` now renews the claim every lease/3 with a compare-and-set on
  the exact `claimedUntil` it set (`renewMessagingUploadJobClaim`), and stops
  once the claim is lost.
- `hubCatalogSeed.ts`: two instances seeding at boot hit P2002 on
  `benchmarkTask.create`. The seed now calls `insertTaskIfAbsent`
  (`createMany skipDuplicates`) and updates the row when another instance won.
- `errorAlert.ts`: dedupe was per process, so each alert posted once per
  instance. A shared TTL lease (`error-alert` namespace) now spans instances
  behind the in-process throttle. It fails open within 1.5 s, so a DB outage can
  double an alert but never silence one.
- `hybridAuth.ts getOrCreateWalletUser`: find-then-create raced on the unique
  `userId` (P2002 → 500 on concurrent first x402 payments). The create is now
  an upsert (INSERT ... ON CONFLICT).

Left per-process on purpose (user decision): the video per-user in-flight cap
and the A2A send budget. Doubling those at N=2 is acceptable, and per-user caps
are rejected.

Why the 2026-10-26 sweep missed them: it targeted Maps/Sets used as flows,
locks and dedupe, and cron claims. These were a promise-chain mutex, a job lease
without renewal, a boot-time find-then-insert, and a find-then-create on a
unique key, i.e. the same class in shapes that sweep's grep didn't cover.

## Human feedback

Andy (2026-10-28, via parent): do NOT make the video per-user in-flight cap or
the A2A send budget global; per-user caps are rejected and doubling is fine.

Parent: do not turn on a second Render instance or autoscaling (spend). Report
it as an approval item with the exact setting and pool math. Andy: no breach
or exposure forensics; contain and fix only.

## Reusable lesson

Never let a module-level Map, Set or promise chain be the source of truth for a flow, lock, dedupe or job claim on the backend; put it in Postgres keyed per flow, renew any lease a slow holder keeps, and write find-then-create as an atomic upsert or skipDuplicates.
