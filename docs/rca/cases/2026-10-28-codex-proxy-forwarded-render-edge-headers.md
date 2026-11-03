---
id: 2026-10-28-codex-proxy-forwarded-render-edge-headers
date: 2026-10-28
title: Codex Fast Mode proxy forwarded Render's Cloudflare edge headers to chatgpt.com, which answered every call with 403
surface: back-end
component: demo-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/domains/demo-cache/routes.proxy.ts codexHeaders, which copied every inbound header except hop-by-hop ones into the upstream fetch
symptoms:
  - "GET /codex-proxy/<trace>/record.<sig>/backend-api/codex/responses -> 403"
  - Codex code session under a DEMO-goal agent never completes its turn in production
  - "Codex proxy MISS ordinal 0" repeated for every retry of the first call
tags:
  - fast-mode
  - demo-cache
  - codex
  - proxy
  - cloudflare
sources:
  - PR #1619
repro: back-end/src/tests/blackbox/demo-cache-isolation.blackbox.ts (fake upstream that 403s edge headers, request carries Render's cf-*/x-forwarded-* headers)
status: fixed
---

## Problem

After `FAST_MODE_ANTHROPIC_PROXY_URL` moved from a dead dev ngrok tunnel to
production (`/anthropic-proxy`, from which `/codex-proxy` is derived), the
first production Fast Mode Codex session (agent
76aac11b-7c50-4d3c-9741-47e2cdb912a5, task f6232043) routed through prod
`/codex-proxy` but every upstream call, including `/backend-api/codex/responses`,
returned 403 and the turn failed. The same session without the proxy completed.

## Diagnosis

The capability check passed (the handler logged `Codex proxy PASS/MISS`), so
the 403 came from upstream. `codexHeaders` forwards all inbound headers except
hop-by-hop ones. Render sits behind Cloudflare and adds `cf-connecting-ip`,
`cf-visitor`, `cf-ray`, `x-forwarded-*` and `true-client-ip` to every request;
the ngrok tunnel never did. Probe from the devbox against chatgpt.com
`/backend-api/codex/models`: no extra headers -> 401 (normal auth refusal);
`cf-connecting-ip` alone -> 403 text/html; `cf-visitor` alone -> 403;
`cf-ray`, `x-forwarded-for`, `true-client-ip`, `cf-ipcountry` alone -> 401.
The Anthropic proxy was unaffected because it forwards an allowlist.

## Solution

`codexHeaders` drops edge/infrastructure headers (`cf-*`, `x-forwarded-*`,
`forwarded`, `true-client-ip`, `x-real-ip`, `cdn-loop`, `via`, `rndr-*`,
`render-*`, `x-request-start`) before the upstream fetch. The regression sends
Render's edge headers through the real proxy routers to a fake upstream that,
like Cloudflare, answers 403 when any of them arrive: it failed before the fix
(`codex plain status 403: edge headers forwarded upstream: cf-connecting-ip,...`)
and passes after. 10k agents: a per-request header filter, no shared state.

## Human feedback

None yet.

## Reusable lesson

A pass-through proxy must forward the client's request, not our own edge's
annotations. A proxy that only ever ran behind a tunnel hides this until it is
deployed behind a CDN; test it with the headers the production edge adds.
