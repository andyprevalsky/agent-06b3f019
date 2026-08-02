---
id: 2026-07-10-agent-preview-endpoint-gated-only-by-env-flag-in-prod
date: 2026-07-10
title: The benchmark agent-preview endpoint was gated only by an env flag, leaving an unauthenticated RLS-free read reachable in prod
surface: back-end
component: benchmarks-api
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: GET /api/benchmarks/agent-preview/:id — guarded by BENCHMARK_MODE only, with no hard prod disable
symptoms:
  - unauthenticated agent read available whenever BENCHMARK_MODE is set
  - RLS-free agent data reachable via /api/benchmarks/agent-preview/:id
tags:
  - security
  - rls
  - benchmark
  - env-flag
  - prod
sources:
  - memory:project_gate_benchmarks_fe_verification
  - commit dc012006
  - commit 302164ed
repro: none-recorded
status: fixed
---

## Problem

`GET /api/benchmarks/agent-preview/:id` exists so benchmark runs can render an
agent without a real authenticated user. Its only guard was the `BENCHMARK_MODE`
environment flag — so any environment where that flag was set, including
production if it were ever set there, exposed an unauthenticated, RLS-free read of
agent data.

## Diagnosis

The endpoint's safety depended entirely on an env var never being true in prod,
which is a configuration invariant, not an enforced one. Env flags drift (they are
copied between `.env` files, inherited by benchmark stacks, and set by tooling), so
"we don't set that in prod" is not a security boundary. Surfaced by an
extra-high-effort code review of the gate work, not by a test.

## Solution

The endpoint is now **hard-disabled when running on Render** (prod), independent of
the env flag, so the benchmark preview path cannot be re-enabled by configuration
alone (commits `dc012006`, `302164ed`). The FE side already restricts its fallback
(`benchmarkAgentPreviewEnabled()` in `front-end/src/lib/api/agents.ts`) to DEV and
VITEST.

## Human feedback

None recorded.

## Reusable lesson

Any endpoint that bypasses authentication or RLS must be disabled by a hard
runtime-environment check, not merely by an env flag that is assumed unset in
production.
