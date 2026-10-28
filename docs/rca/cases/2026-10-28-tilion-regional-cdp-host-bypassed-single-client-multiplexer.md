---
id: 2026-10-28-tilion-regional-cdp-host-bypassed-single-client-multiplexer
date: 2026-10-28
title: Tilion CDP URLs on a regional host skipped the single-client multiplexer, so browser-use and Playwright each dialled Tilion and the second was refused with 4409
surface: agents
component: agents/utils/url_redaction.py tilion_hosts + agents/domains/spawn_browser_agent_v3/cdp_urls.py is_tilion_cdp_url
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: is_tilion_cdp_url matched only back.tilion.dev (plus the host of TILION_BASE_URL); Tilion serves a session's CDP and live-view URLs from a regional subdomain (east.back.tilion.dev in prod, oregon.back.tilion.dev at diagnosis), so open_browser_cdp_connection returned the raw provider URL with no multiplexer
symptoms:
  - "BrowserType.connect_over_cdp: Target page, context or browser has been closed ... another client is attached to this session"
  - "<ws disconnected> wss://east.back.tilion.dev/v1/session/sess_.../cdp code=4409 reason=another client is attached to this session"
  - every browser sub-agent failed at initialization; Tilion sessions were created and deleted about 10 s later
tags:
  - tilion
  - browser-provider
  - cdp-multiplexer
  - single-client
  - regional-host
sources:
  - agent 244da2cb-9e56-46f8-b865-51186c04e416 (prod check agent, 2026-10-28 06:29-06:40Z, Render BROWSER_PROVIDER=tilion for about 27 minutes; worker logs in ClickHouse observability.fly_logs)
  - benchmark run browser-smoke agent 0caa2e5e-7169-41f7-b493-91cec6ec48f2 (scripts/run-bench --local with BROWSER_PROVIDER=tilion on 87438cdc3)
repro: agents/tests/blackbox/browser_tilion.blackbox.py (tilion_regional_hosts_use_the_single_client_multiplexer); unchanged scripts/run-bench --local browser-smoke with BROWSER_PROVIDER=tilion
status: fixed
---

## Problem

PR #1604 made Tilion the default browser provider. After merge, Render was set to
`BROWSER_PROVIDER=tilion` and a production check agent (open example.com, report the
heading) failed: each browser sub-agent died during initialization with Playwright's
`connect_over_cdp` closed by Tilion with code 4409, "another client is attached to
this session". The backend had created the Tilion session and the worker was the only
client we intended to attach. Render was reverted to `kernel` about 27 minutes later.

## Diagnosis

Tilion admits one CDP client per session. The worker therefore opens a loopback
multiplexer (`SingleCdpConnectionMultiplexer`) that owns the only upstream socket, and
browser-use and Playwright both attach to the loopback URL. `open_browser_cdp_connection`
opens the multiplexer only when `is_tilion_cdp_url(cdp_url)` is true.

That predicate compared the URL host with `tilion_hosts()`: `back.tilion.dev` plus the
host of `TILION_BASE_URL`. A live `POST /v1/session` shows the CDP URL host is a
regional subdomain of the deployment: `oregon.back.tilion.dev` at diagnosis, and
`east.back.tilion.dev` in the production worker log. Neither is in the set (prod
`TILION_BASE_URL` is `https://back.tilion.dev`). So the predicate said "not Tilion",
`open_browser_cdp_connection` returned the provider URL untouched, and the worker's
DOMService and its Playwright connection each dialled Tilion directly. The worker log's
Playwright call log shows `<ws connecting> wss://east.back.tilion.dev/...`, not a
loopback address, which is how the bypass was identified.

The same predicate gates URL secret redaction, so persisted and logged Tilion
`browser_url` values with a `?token=` on a regional host were also not masked.

It escaped every gate because local smoke and the anti-bot lanes ran the browser on
Kernel (`back-end/.env` has `BROWSER_PROVIDER=kernel`), the fake Tilion gateway tests
use `back.tilion.dev` or a loopback host, and the live Tilion cases drive the backend
adapter, not the worker's connection setup. Earlier real-Tilion lanes had used the
apex host; the regional naming is how the API answers now.

## Solution

- `utils/url_redaction.py`: new `is_tilion_host(hostname)`: the deployment root or any
  subdomain of it (`host == root or host.endswith("." + root)`), case-insensitive,
  trailing dot ignored. Lookalikes (`evilback.tilion.dev`, `back.tilion.dev.evil.example`,
  `tilion.dev`, `east.tilion.dev`) do not match. `redact_url_secrets` and
  `is_tilion_cdp_url` both use it, so connection setup and secret masking agree.
  This matches the suffix rule `_BROWSER_PROVIDER_DOMAIN_SUFFIXES` already used for
  the site-unlock domain guard.
- Regression: `browser_tilion.blackbox.py` `tilion_regional_hosts_use_the_single_client_multiplexer`
  asserts regional hosts are recognised, tokens are masked on them, the multiplexer
  (not the raw URL) is opened for a regional CDP URL, lookalikes are rejected, and a
  `TILION_BASE_URL` override keeps working. It failed before the fix at the first
  regional host and passes five times in a row after.
- Outcome proof: the unchanged `scripts/run-bench --local browser-smoke` with
  `BROWSER_PROVIDER=tilion` failed on 87438cdc3 with the 4409 above and is rerun on the
  fixed revision.
- Secondary finding from the outcome-proof run: `browser-smoke` PASSED on Tilion with the fix,
  but the command exited 1 because `scripts/cloudbench-exact-session-cleanup.py` retried
  only HTTP 503 on the idempotent Tilion DELETE and a single gateway 502 failed the
  run's owned-cloud-evidence finalization (the session was already gone). 502 and 504 are
  now retried like 503 (bounded; 401/500 still fail at once); the existing
  `cloudbench-exact-session-multi-root` test covers it and fails without the change.
- 10k agents: pure string comparison per session; no new shared state, connections, or
  queries. The multiplexer already owns one upstream socket per session.

## Human feedback

Andy asked for the failure to be diagnosed with /rca and the deploy finished once
OpenRouter was topped up.

## Reusable lesson

Match a provider's URLs by the deployment's domain, not a single literal hostname:
providers shard by region, and a host check that gates connection topology (one client
versus many) fails closed into the wrong topology. Run the real provider end to end on
the path that changes it before making it the production default.
