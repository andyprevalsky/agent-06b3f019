---
id: 2026-07-08-benchmark-agent-owner-mismatch-blocked-by-rls-in-open-agent-view
date: 2026-07-08
title: '"Open agent" rendered a blank page because RLS blocked the dev-login user from reading API-key-owned benchmark agents'
surface: harness
component: cloudbench-archive
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end auth — dev auto-login authenticates as a different Supabase user than the benchmark agent's owner, so owner-only RLS returns no rows
symptoms:
  - '"open agent" on the cloud-benchmark dashboard opens a dead/blank localhost'
  - benchmark agent detail renders empty in a real frontend
  - "flyctl proxy of the box frontend leaves Chrome blank"
tags:
  - cloudbench
  - rls
  - supabase
  - benchmark-viewer
  - flyctl-proxy
sources:
  - memory:project_cloudbench_open_agent_rls_archive
repro: none-recorded
status: fixed
---

## Problem

Clicking "open agent" on the cloud-benchmark dashboard produced a dead or blank
localhost page instead of the agent view. Verified against the warm box
(`navi-whisper-lux-bench`, machine `6834251fe05798`).

## Diagnosis

Benchmark agents are created through the API-key path with
`X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30`, so that user owns the rows.
Any real frontend, however, authenticates as a _different_ Supabase user — dev
auto-login uses `+15555550123`. Row-level security is owner-only, so that user
simply cannot read the agent and the page renders empty. Not a rendering bug: an
identity mismatch surfacing as absent data.

The prior approach — `flyctl proxy` the box's frontend to the Mac — was broken
three additional ways on top of RLS: CORS across origins;
`resolveBackendBaseUrl` infers the backend at `frontendPort - 1`, where no proxy
was listening; and `flyctl proxy` is unreliable for a streaming frontend
("leaves Chrome blank"). So every layer of that path had to be replaced, not
patched.

## Solution

Route every `/open-agent` click through the benchmark **archive** frontend
(`VITE_BENCHMARK_ARCHIVE=1`, fake user, realtime off) — the only RLS-free viewer.
To make it work _during_ a run, when no `run.json` exists yet,
`agents/benchmarks/archive_api.py` gained a live upstream proxy: `/api/agents/*`
and `/api/tool-usage/*` are forwarded to the box backend with `X-API-Key` +
`X-User-Id` (the API-key path bypasses RLS), falling back to the hot-reloaded
static `run.json` once the box is gone. `run-bench-cloud` now runs
`flyctl proxy 8766:3001` against the box **backend** rather than its frontend and
passes `--upstream-url/--upstream-api-key/--upstream-user-id` to
`agent_link_server.py`. Single-origin (archive FE → local archive API) removes
CORS, and `agent_link_server` always resolves to a working view or a clean
auto-refreshing retry page instead of a dead localhost. The archive API/opener
construct their clients with `ProxyHandler({})` so a localhost upstream never
routes through the ambient fast-mode HTTP proxy, which otherwise converts a
refused connection into a bogus 500. Verified end-to-end:
`/open-agent?agent-id=<live>` → 302 → live archive FE → archive API proxies the
box → ACTIVE agent with live messages.

## Human feedback

The user insisted on no wasted resources / no zombie workers, which shaped the
lifecycle work: exactly one reused archive Vite deduped via
`archive-frontend-live.json` + `_LAUNCH_LOCK`, reaped at run start and on exit
via `stop_live_archive_frontend`, with a separate pid file for the durable
post-run static archive.

## Reusable lesson

When a viewer renders empty rather than erroring, compare the _identity_ that
wrote the rows with the identity reading them — owner-only RLS turns an identity
mismatch into a blank page, and the fix is an RLS-free viewer or an API-key
proxy, not more frontend debugging.
