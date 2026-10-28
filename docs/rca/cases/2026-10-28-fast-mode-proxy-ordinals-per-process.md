---
id: 2026-10-28-fast-mode-proxy-ordinals-per-process
date: 2026-10-28
title: Fast Mode proxy call ordinals were per-process, so two backend instances recorded and replayed the same slot
surface: back-end
component: demo-cache
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/anthropicProxyCore.ts and codexProxyCore.ts module-level traceOrdinalCounters Map, read by routes.proxy.ts for every trace session call
symptoms:
  - "A then B must take slots 0 and 1, got 0 and 0"
  - Fast Mode replay serves the wrong turn for a code-agent session split across instances
  - recordings of one trace session overwrite each other's slots
tags:
  - multi-instance
  - scale-out
  - demo-cache
  - fast-mode
  - shared-state
sources:
  - memory:scalability-audit-100-seats-20261024.md
  - PR #1587
repro: back-end/src/tests/blackbox/multi-instance.blackbox.ts (two Node processes, one local Postgres)
status: fixed
---

## Problem

Before scaling the prod backend from one to two Render instances (S25), the
Fast Mode tee-proxy (`/anthropic-proxy`, `/codex-proxy`) numbered each trace
session's calls with a module-level `Map`. A code-agent sandbox sends its
session's sequential LLM calls to whichever instance the load balancer picks,
so with two instances both start counting at 0. The Nth call's recording
(`fastmode:...:slot:N`) is overwritten by another call, and a replay serves a
different turn's response.

## Diagnosis

`routes.proxy.ts` called `resolveAnthropic` / `resolveCodex` without an
ordinal, so each core reserved one from `traceOrdinalCounters` in its own
process memory. S16's two-process harness reproduced it. A session's first call
ran in process A and its second in process B, and both recorded slot 0
(`got 0 and 0`). Overlapping calls also shared a slot.

## Solution

- `providers/sharedState.ts` gains `nextSequenceValue` / `releaseSequenceValue`:
  - one atomic `SharedEphemeralState` UPSERT per step (an absent or expired row
    restarts at 0);
  - a token minted before the statement, so a query-layer replay of a committed
    step returns the same value;
  - a compare-and-set give-back that applies only while nothing was taken after it.
- Both proxy cores take a required injected `ReserveTraceOrdinal`
  (`providers/traceOrdinal.ts`). The routes pass `PROXY_ORDINAL_RESERVER`, a
  Postgres sequence per `<kind>:<traceHash>:<sessionId>` with a 7-day TTL
  refreshed on each call (`traceOrdinalShared.ts`). Unit tests inject an
  in-memory reserver. A failed give-back is swallowed: it can only leave a slot
  gap, never replace the upstream response.

Regression (multi-instance blackbox):
- Anthropic and Codex sessions split A then B take slots 0 and 1, and
  overlapping calls take distinct slots.
- A sequence step whose commit ack is lost is taken once.
- A value given back on one instance is reused by the other.

On origin/main the first two fail with `got 0 and 0`. Dropping the replay-token
clause fails the lost-ack case (`value 1`).

Scale (10k agents): one UPSERT per proxied LLM call. The row is per trace
session, so it is contended only by that session's own sequential calls.
Rows are reaped by TTL. Nothing grows with instance or agent count.

## Human feedback

Parent (S25 assignment): Andy approved scaling the prod backend to N=2; nothing
scales until the cross-instance blockers are fixed. Reproduce each with S16's
two-process harness, fail-before and pass-after.

## Reusable lesson

Any counter that orders a session's requests must live where every instance
reads it. Per-process numbering is correct only while one process serves the
whole session.
