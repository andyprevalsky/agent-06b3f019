---
id: 2026-07-19-prod-benchmark-frontend-url-hijacked-by-local-manifest
date: 2026-07-19
title: A --prod benchmark resolved its frontend URL from a leftover local-stack manifest and sent the cloud browser agent to a dead ngrok tunnel
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: _frontend_url_for_benchmark(base_url) — it consults PUBLIC_BASE_URL and services.json urls.public before the roselabs.ai fallback and never checks whether the run is --prod
symptoms:
  - prod lifecycle bench navigates to "rose-<workspace>.ngrok.app" instead of roselabs.ai
  - browser agent stuck in a navigate-then-refresh loop
  - agent never reaches the real prod checkout
tags:
  - benchmark
  - prod-run
  - ngrok
  - url-resolution
  - agentcard
sources:
  - PR #790
repro: none-recorded
status: fixed
---

## Problem

Running the AgentCard production lifecycle bench
(`agent-payment-production-abandonment --prod`) sent the cloud browser agent to
`rose-<workspace>.ngrok.app` — the local `run.sh` tunnel — instead of
`roselabs.ai`. With the local stack down that tunnel is unreachable, so the agent
entered a navigate→refresh loop and never reached the real prod checkout.

## Diagnosis

`_frontend_url_for_benchmark(base_url)` resolved the frontend URL by consulting
local-stack signals first: the `PUBLIC_BASE_URL` env var, then
`.context/.../services.json`'s `urls.public`, and only then falling back to
`roselabs.ai`. It never consulted whether the run was `--prod`. So any stale local
manifest left on disk from a previous local run silently hijacked a live prod
run. The deepest owned cause is precedence: environment-local discovery was ranked
above the explicitly requested target, which makes the harness's target a function
of leftover state rather than of the flag the operator passed.

## Solution

After the explicit `BENCHMARK_FRONTEND_URL` override, the resolver now
short-circuits to `https://roselabs.ai` whenever `base_url` is the prod backend
(`navi-j9a9.onrender.com` or `api.roselabs.ai`). Local runs never enter that
branch, so they are unchanged. Verified by re-running
`agent-payment-production-abandonment --prod`: the browser agent navigated to
`https://roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle`, reached
"Payment card requested ($0.50)", and exercised live Stripe (hold created,
idempotent cleanup refunded → net $0). Logic verified for prod backend,
`api.roselabs.ai`, local-ngrok, and explicit-override cases; ruff clean.

## Human feedback

None recorded.

## Reusable lesson

When a run declares an explicit target (`--prod`), that declaration must outrank
every ambient local-stack discovery signal — otherwise stale workspace manifests
silently redirect production runs.
