---
id: 2026-05-04-subagent-geolocation-resolved-from-worker-ip
date: 2026-05-04
title: Sub-agent proxy geolocation was resolved from the worker's IP, giving children Fly's location instead of the user's
surface: back-end
component: agent-spawn
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: sub-agent create path — `getGeoFromIP` was called with the spawning worker's IP rather than inheriting the parent agent's proxy
symptoms:
  - sub-agents browse from Fly's datacenter geolocation, not the user's
  - getGeoFromIP roundtrip on every spawn adds latency to the fan-out hot path
  - parent and child agents disagree about proxy region
tags:
  - spawn-agent
  - proxy
  - geolocation
  - browser-agent
  - fly-io
sources:
  - PR #561
repro: back-end/src/tests/blackbox/agents.blackbox.ts
status: fixed
---

## Problem

Profiling a 30-agent fan-out load test (`load-test-sias`) on prod with
`agent_latency.py` (254 s wall, 17 spans ≥ 300 ms, 0 errors) surfaced a
`getGeoFromIP` call on every sub-agent spawn. The call was made against the
spawning worker's IP, so each sub-agent was assigned a proxy derived from Fly's
datacenter geolocation rather than the user's — a correctness bug, not just the
~240 ms/spawn cost it was found as.

## Diagnosis

Sub-agents were created through the same path as root agents, which derives proxy
geolocation from the request's originating IP. For a root agent that IP belongs
to the user; for a sub-agent the request originates from the Temporal worker, so
the "user's location" silently became the worker's location. The enabling cause
is reusing a request-scoped derivation (client IP → geo) in a machine-originated
context where the request no longer carries user identity — the derived value is
plausible, never null, and therefore never trips an error.

## Solution

Sub-agents now inherit the parent agent's proxy directly instead of re-deriving
geolocation from whatever IP happens to make the create call. This removes the
per-spawn `getGeoFromIP` roundtrip and fixes the correctness bug in one change.
Landed with the batch-spawn work that collapsed 30 sequential `POST /api/agents`
calls into one `POST /api/agents/batch`; the batch endpoint's parent-proxy
inheritance is covered by a dedicated blackbox case.

## Human feedback

None recorded.

## Reusable lesson

Any value derived from the incoming request's IP is wrong for machine-originated
creates — inherit it from the parent record instead of re-deriving it.
