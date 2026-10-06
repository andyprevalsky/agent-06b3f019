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
  - "https://<name>.trycloudflare.com/test_payment returned HTTP 530, expected 200"
  - "RuntimeError: run.sh exited early with code 1"
  - "edge identity: proxy HTTP 200 must not count as tunnel routing"
  - "❌ https://<worktree>-bench-<run>-bench.ngrok.app never routed."
  - "failed to start tunnel: The endpoint 'https://rose-<worktree>.ngrok.app' is already online (ERR_NGROK_334)"
tags:
  - cloudflared
  - tunnel
  - smoke-benchmark
  - rate-limit
  - deploy-gate
sources:
  - commit c59ee25a8
  - memory:project_trycloudflare_quick_tunnel_flakiness
  - PR #1419
  - PR #1416
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

### 2026-10-06: an HTTP response did not identify the intended edge

CodeRabbit comment `4192570809` on `ec586779280340df50c3d9ece34015716eceab61`
identified another incomplete early-readiness proof. The status-only helper
accepted an inherited proxy's HTTP 200 or 403 block page because neither was
000 or 530. That can skip quick-tunnel recycling and provider fallback. The
later browser/app-shell smoke still rejects unrelated pages, so this is an
owned startup/fallback defect, not a false final stack-ready verdict or evidence
that Freedom, a proxy or a provider malfunctioned.

Archive searches used `proxy HTTP 200 HTTP 403 cloudflare edge routing` and
`quick tunnel block page readiness fallback browser`. The earlier status-only
transport fixtures supplied no response identity and represented a blocked
route only as 000. The existing routing blackbox now models real curl headers
and requires proxy 200/403 rejection, including a block page after earlier
Cloudflare-looking CONNECT headers. Its unchanged full command,
`bash scripts/tests/run-public-tunnel-routing.test.sh`, first failed at the
new proxy-200 assertion in **5.181s**, with the original 200/502/404 positives
passing, then completed the full suite with **23 PASS markers in 43.683s** and
identical test bytes.

The supervised probe captures headers in a private temporary file and accepts
status only when the final HTTP response has the Cloudflare server and ray
identity. It removes both temporary files after the owned curl joins. Genuine
pre-origin 502/404 responses remain valid; 530/000 remain invalid. Configured
proxy settings, normal resolver/destination routing, IPv4 preference, status
interface, watchdog, retry cadence and all existing deadlines are preserved.
The three unchanged browser-smoke controls also passed in **1.377s**. Private
receipts are `tunnel-permanent-{red,green}.safe.json` and
`browser-smoke-owning-inverses.safe.json` under
`.context/fresh-deploy-group4-20261006/review-continuation/`.

This adds bounded header parsing to the existing per-stack probe, with no
agent-wide scan, shared locks, new provider/model probes or network-policy
overrides at ten thousand agents. The early probe cannot reuse the later app
shell assertion because the frontend is not started yet; verifying the
existing response's identity preserves the two phases' distinct contracts.

### 2026-10-06: the Cloudflare identity check rejected every ngrok fallback

PR #1416's Group 4 smoke on merged HEAD `6e72af2f0` exited 1. Its isolated
stack (`1791274973-1205391-31326`) and the concurrent AgentCard lifecycle
stack (`1791274972-1205215-21299`) each lost the 10s quick-tunnel window, then
reported their run-scoped ngrok fallback as `never routed`. Both raced for the
worktree's single reserved domain; the lifecycle stack won and the smoke stack
died with ERR_NGROK_334. The same fallback had routed on the pre-merge tree.

The fallback's own `ngrok-fallback.log` recorded six `failed to open private
leg` requests: the ngrok edge was delivering probes to this agent while the
origin was not yet listening. The first bad boundary is the shared probe: the
identity check above requires `Server: cloudflare` and `CF-Ray`, and
`start_ngrok_ephemeral_tunnel` reused `cloudflare_tunnel_edge_is_routing`.
A live ngrok edge returns 502 `ERR_NGROK_8012` before the origin starts and
the origin's own headers afterwards, so it can never carry that identity. The
routing blackbox missed it because case 10 stubbed the routing function.

Problem class: a provider-specific readiness proof applied to another
provider through a shared helper. Live repro with real ngrok and curl against
an unused run-scoped domain: the shipped fallback failed in 13s; the fixed
fallback reported ready in 2s. `ngrok_tunnel_edge_is_routing` probes a unique
URI through the configured route and accepts it only when this agent's local
inspection API recorded that URI, so offline endpoints (`ERR_NGROK_3200`),
proxy block pages and dead routes stay rejected. Only the agent's exact local
address bypasses the proxy. New case 14 drives the shipped fallback through
modeled edge states. The unchanged full suite failed at case 14's
`agent-down` positive on the pre-fix `run.sh` (50.0s), passed with
**25 PASS markers in 56s** on the fix, and a mutant that skips the record
check fails the `offline` negative.

At ten thousand agents this remains one per-stack probe plus one loopback GET
per attempt, with no shared endpoint, lock or agent-wide scan. Run-scoped
fallback domains are unique, so concurrent stacks no longer reach the
single-holder worktree domain merely because the fallback was misclassified.

## Human feedback

The October 5 standing user instruction requires preserving Freedom and its
blocking configuration. This recurrence must preserve inherited proxy,
resolver and destination policy, including when that route rejects a request.

## Reusable lesson

Verify a tunnel's edge actually routes before returning its URL — treat origin-facing
502/404 as healthy, but persistent HTTP 000 or Cloudflare 530 as dead — and never probe
a rate-limited quick tunnel, since each attempt deepens the limit. Prove each
provider's edge with that provider's own evidence; never reuse one provider's
identity check for another.
