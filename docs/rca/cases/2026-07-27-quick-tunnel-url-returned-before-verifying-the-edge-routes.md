---
id: 2026-07-27-quick-tunnel-url-returned-before-verifying-the-edge-routes
date: 2026-07-27
title: The Cloudflare quick tunnel's published URL was trusted without verifying the edge routes, so a dead tunnel killed the smoke stack
surface: harness
component: deploy-pipeline
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: start_cloudflare_quick_tunnel — returned as soon as cloudflared printed a URL, with no check that the Cloudflare edge actually routes to the origin
symptoms:
  - "https://<name>.trycloudflare.com/test_payment returned HTTP 000, expected 200"
  - "https://<name>.trycloudflare.com/test_payment returned HTTP 530, expected 200"
  - "RuntimeError: run.sh exited early with code 1"
  - "every new tunnel is dead after ~6-9 in quick succession, not recovering within ~15 min"
tags:
  - cloudflared
  - tunnel
  - smoke-benchmark
  - rate-limit
  - deploy-gate
sources:
  - commit c59ee25a8
  - memory:project_trycloudflare_quick_tunnel_flakiness
repro: scripts/tests/run-public-tunnel-routing.test.sh
status: fixed
---

## Problem

Pre-Deploy smoke runs failed in a way that looks exactly like a product bug:

```
❌ https://<name>.trycloudflare.com/test_payment returned HTTP 000, expected 200
🛑 Stopping all services...
RuntimeError: run.sh exited early with code 1
```

The isolated benchmark stack (`scripts/run.sh --benchmark`) opens an **account-less**
Cloudflare quick tunnel (`cloudflared tunnel --url`, `*.trycloudflare.com`) for the
public frontend. It is best-effort with no uptime guarantee, and it was the single most
common cause of this failure.

## Diagnosis

Three related third-party failure modes can surface before the origin is usable:

1. **Dead hostname.** `cloudflared` publishes a URL within about 2s and DNS resolves it
   to real Cloudflare IPs, but the edge never routes to the origin. One measured instance
   stayed dead for 180s+.
2. **Per-IP rate limiting.** After roughly 6–9 tunnels in quick succession, _every_ new
   tunnel is dead. Observed 2026-07-27; it did **not** recover within ~15 minutes. Each
   diagnostic probe deepens the limit, so probing makes it worse.
3. **Cloudflare no-live-route response.** On 2026-09-04 a published quick-tunnel URL
   repeatedly answered HTTP 530. The readiness helper accepted every non-000 response,
   so it returned this dead URL; the later strict `/test_payment` smoke correctly
   required 200 and tore down the isolated stack before the benchmark agent started.

The owned defect: `start_cloudflare_quick_tunnel` treated "cloudflared printed a URL" as
"tunnel is usable" and returned immediately. Because a published-but-unrouted hostname is
a normal outcome of this free service, the stack committed to a dead public URL and then
failed much later, in the smoke assertion, where the cause is invisible.

A crucial detection subtlety: the origin frontend is **not** up when the tunnel is
created, so **502/404 means healthy** — it proves the edge routed to the local origin.
Persistent `000` means no HTTP response, while Cloudflare's `530` for a quick-tunnel
hostname means there is no live tunnel route. A naive "expect 200" readiness check would
reject good tunnels; accepting every non-000 response admits a dead one.

## Solution

Fixed in `c59ee25a8`: `start_cloudflare_quick_tunnel` now verifies the edge actually
routes before returning, kills and re-requests a new tunnel on failure (3 attempts,
linear backoff), and de-registers the dead pid from `PIDS`/`NAMES` so cleanup stays
correct. Knobs: `CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS` (45),
`CLOUDFLARE_TUNNEL_MAX_ATTEMPTS` (3), `CLOUDFLARE_TUNNEL_RETRY_BACKOFF_SECONDS` (20).

Cemented by `scripts/tests/run-public-tunnel-routing.test.sh`, wired into
`scripts/run-deploy-structural-gates.py`.

The 2026-09-04 recurrence was fixed by rejecting HTTP 530 in the early edge-routing
probe. That forces the existing recycle/fallback path to select another tunnel before
the stack publishes the URL. The focused regression now covers persistent 530 as a
bounded failure while retaining 404 and 502 as healthy pre-origin responses.

When rate-limited there is no code fix — wait it out, or use
`BENCHMARK_SKIP_PUBLIC_TUNNEL=1` for runs that genuinely need no public origin (not valid
for browser smoke tasks, which require the public URL).

## Human feedback

None recorded.

## Reusable lesson

Verify a tunnel's edge actually routes before returning its URL — treat origin-facing
502/404 as healthy, but persistent HTTP 000 or Cloudflare 530 as dead — and never probe
a rate-limited quick tunnel, since each attempt deepens the limit.
