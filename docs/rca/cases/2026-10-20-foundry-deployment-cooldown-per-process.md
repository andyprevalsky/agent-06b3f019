---
id: 2026-10-20-foundry-deployment-cooldown-per-process
date: 2026-10-20
title: Every worker process kept its own 1 s Azure Foundry cooldown and re-hit rate-limited deployments
surface: infra
component: rose-foundry-routing
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/foundry.py kept _cooldown_until as a per-process dict and gave in-stream rate limits a 1 s default because _cooldown_seconds read only the HTTP-200 stream headers
symptoms:
  - "rose.foundry.stream_failed error_type=RoseRateLimitError region=<westus host>"
  - "Requests to the Responses API have exceeded token rate limit"
tags:
  - foundry
  - azure
  - rate-limit
  - cooldown
  - benchmark
  - cloudbench
sources:
  - fleet run 20261020-043809-29063
  - fleet run 20261020-043620-26484
repro: back-end/src/tests/blackbox/compute-token-authority.blackbox.ts
status: open
---

## Problem

During the 60-guest Polar batch, 18 guests logged 902 westus
`rose.foundry.stream_failed` events. Per-guest gaps between rejections were
p10 4.9 s, p50 14.7 s, p90 53 s: each guest re-sent nearly every browser step
to the deployment that had just rejected it. 809 of 884 repeat rejections came
within 61 s of the previous one. Production has the same gap: 8 or more Fly
Machines each keep their own dict.

## Diagnosis

1. `_cooldown_until` was a module dict, so a rejection seen by one process
   never reached another worker process, guest or Fly Machine.
2. In-stream rejections (`response.failed` with `rate_limit_exceeded`) arrive
   on an HTTP 200 response. `_cooldown_seconds(response.headers)` found no
   Retry-After there and defaulted to 1 s; Azure's message carries no "try
   again in" value either.
3. Why possible: the cooldown lived next to the request instead of next to the
   shared resource (the deployment's quota), and "no advice" was treated as a
   1 s hint instead of an unknown.

Local repro: two real agent worker processes, each bound to its own guest
backend, both delegating to one authority backend
(`compute-token-authority.blackbox.ts` section 3). Pre-fix:
`worker B (guest B) sent 1 request(s) to gpt-6-sol-a, which worker A (guest A) saw rate limited; worker B hits=gpt-6-sol-a; authority cooldown rows=0`.

## Solution

- Backend: `providers/foundryDeploymentCooldown.ts` stores one row per
  `(region host, deployment)` (Integration sentinel, like the Cerebras key
  cooldown). `token/rate-limited type=foundry` marks it,
  `GET /compute-code/foundry-deployment/cooldown?keys=` reads every
  deployment of a route plan in one query, and
  `POST /compute-code/foundry-deployment/served` resets the escalation. The
  compute-token authority forwards all three (benchmark guests, A1).
- Length (B1): the provider's retry advice when present (Retry-After, else the
  in-stream "try again in N s|ms|seconds",
  `codex/codex-rs/codex-api/src/sse/responses_error.rs:90-125`, regex at
  `:137-143`), otherwise 30 s, 60 s, then 300 s per deployment
  (`openclaw/src/agents/auth-profiles/usage-failure-state.ts:18-27`). The strike
  count survives expiry and resets on a served request (openclaw's rate-limit
  counter is half-open until success, `:94-97`); a rejection inside an active
  window adds no strike (in-flight requests of the same burst). The 300 s cap
  applies only to the fallback ladder: provider hints over 300 s are honored.
- Agents: `foundry.py` marks the local cache at once, publishes the mark,
  adopts the shared expiry/strikes, and refreshes stale deployments (5 s) in
  one single-flight read before routing. A previously healthy cache can miss
  another process's new mark until its five-second TTL expires; the next
  routing call refreshes it, with a two-second RPC deadline. This is bounded
  cache propagation, not instantaneous exclusion or cancellation of in-flight
  requests. No backend key keeps the local-only behavior; a configured but
  unavailable authority fails closed for Foundry.
- Regressions: `compute-token-authority.blackbox.ts` sections 3 and 4
  (fresh and already-warm cross-process readers, reopening after expiry,
  ladder, 900 s hint, served reset, in-window no escalation) and
  `rose.blackbox.py` `foundry_rate_limit_cooldown_hint_ladder_shared`.

Note: openclaw's current `rate_limit` reason uses a capped exponential from
30 s (`usage-failure-state.ts:49`); 30/60/300 is its regular transient ladder,
which is the bound Andy approved.

Load: one indexed cooldown read per stale route-plan set per worker per five
seconds, and one write per rejection. Traffic grows with active worker count
and distinct deployment sets, rather than opening a database pool per worker.

Rollout order: backend authority first (new routes must exist), then workers
and benchmark launchers. Production workers keep their own backend URL;
this implements the approved B1 production gap fix. No deploy or unchanged
Polar task outcome proof was performed; this case remains open.

## Human feedback

Andy approved on 2026-10-20: copy Codex's "try again in" parsing and fall back
to OpenClaw's 30/60/300 s escalation; share the cooldown through the same
authority for every benchmark guest and production worker.

## Reusable lesson

Keep a rate-limit cooldown next to the shared quota it describes, and treat a rejection without retry advice as an escalating unknown, never as a 1 s hint.
