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
  - "edge identity: proxy HTTP 200 must not count as tunnel routing"
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
  - PR #1420
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

### 2026-10-06: the Cloudflare identity check was also applied to ngrok

The required PR #1420 smoke and AgentCard gates both stopped before task
execution on immutable `795cb6773b28898b6d50fbfafdda283c867e99c2`. Their
normal documented concurrent commands selected eight smoke tasks and four
sequential payment tasks, but exited 1 after **45.191s** and **48.841s**.
Neither produced a task report card, benchmark result, evaluator outcome or
agent ID. Both created isolated Postgres databases; this was not zero stack
allocation. Exact run owner/token/birth cleanup receipts matched, and native
checks found both owned stack PIDs, ports, Docker containers and volumes gone.
These rejected gates must be rerun; infrastructure reproduction earns no
benchmark, cache, judge or payment lifecycle acceptance credit.

The first bad boundary was `start_ngrok_ephemeral_tunnel` calling
`cloudflare_tunnel_edge_is_routing`. The tightened final-response identity
check required Cloudflare's server and ray headers for every provider. The
original native JSON logs show both unique ngrok endpoints started with their
correct distinct loopback frontend ports. Connection refusal before the
frontend starts is expected. After the authentic ngrok response was rejected,
the last-resort stable worktree endpoint collided with the unrelated shared
semantic stack (`ERR_NGROK_334`); that collision was downstream. An earlier
source-qualified deploy accepted three simultaneous independent endpoints
with the same isolated naming setup. No endpoint pooling, provider credentials,
proxy, Freedom configuration or frontend allowed-host changes were needed.

An unchanged native full-fallback driver executed the actual shipped functions
on the captured original source and candidate. With the original owned
frontend port closed, both versions received **HTTP 400** with final
`Ngrok-Error-Code: ERR_NGROK_8012` and a current-child `started tunnel` JSON event
binding the exact requested HTTPS URL and `http://localhost:28021`. Original
source failed in **5.378s**; the candidate passed in **2.357s**. The same driver
bytes were used for both, including identical fixture-only Host-header rewriting
and `exec` custody. The rewriting represents an already-running origin's
allowed-host setup in the separate healthy-origin check; it is absent from
production launch commands. Current-child PIDs were absent after join and each
rebind waited for the exact owned endpoint's native **404/ERR_NGROK_3200**
retirement proof. Earlier rejected attempts, including an immediate rebind
before asynchronous provider retirement, remain preserved.

Healthy-origin coverage stayed distinct: the actual existing shared local and
public frontend both answered 200 with the app mount marker and identical
5,015-byte bodies. The actual full caller on original source rejected that
healthy ngrok route in **7.541s**; the candidate accepted it in **3.366s** using
the unchanged healthy driver. The shared stack and endpoint were never modified.
No backend, worker, browser, model or task was launched by these native proofs.

The fix keeps the Cloudflare final-header guard intact. Ngrok first requires
its own fresh native JSON event to match the requested URL and upstream before
publishing an origin; foreign URL or port fails closed. Initial log absence
remains pending, while invalid observed ownership fails. Its explicit provider
probe accepts the captured 400/8012 pre-origin response, or a healthy 200 only
with the app marker and byte-identical body from the expected local frontend.
Offline 404/3200, unmarked errors, proxy block pages, earlier CONNECT identity,
and another origin's body are rejected. Both curl children retain the existing
watchdog and inherited proxy aliases, join before return, and remove private
body/header files. No global ngrok API port is used as ownership authority.

The existing case-10 fixture had replaced the real routing helper with
unconditional success, masking this cross-provider regression. It now executes
the actual fallback and actual route helpers using source-derived native event
and response fixtures. Frozen compact assertions first failed on original
source in **3.204s**, then passed unchanged in **21.595s** (12 fallback
invocations, seven PASS markers), including delayed publication, foreign
URL/upstream, offline/unmarked/proxy/CONNECT/wrong-body rejection and all proxy
aliases. The complete existing routing family passed **28 PASS markers in
63.815s**. Test relocation changes only the fixture's repository-root wiring;
production retains its normal relative root. Reviewed `run.sh` SHA-256 is
`8515e835a33ae5830a75b2963746e45ee02e54d9631ee2cadc84d85c6675d23c`.

Private source, headers, native logs, unchanged drivers, rejected controls and
sanitized receipts are preserved under
`.context/basic-cli-native-validation-20261006T112941Z/group4-live/tunnel-rca/`.
The full-caller pre-origin receipt is
`private-overlay/native-preorigin-full-final/native-preorigin-final-red-green.safe.json`;
healthy-origin qualification is
`private-overlay/native-healthy-final-after-release/native-healthy-green.safe.json`.
The independent reviewer checked the final source, frozen assertions and both
native outcomes before production application. The normal routing family
remains registered in the compact deploy gate. Required normal smoke/payment
workloads remain separate gates with their task, model, evaluator and timeout
contracts unchanged.

The subsequent actual normal invocations on `729ffeab` passed the repaired
provider boundary and executed every selected task. The original smoke batch
ran seven tasks (six PASS, one genuine new-user payment evaluator FAIL) and
exited 1 in 744.075 seconds. Its unexecuted cached selection ran once separately:
PASS in 215.3 seconds of execution, 300.430 seconds for the complete CLI. The
four unchanged AgentCard cases all passed in 957.005 seconds. The user's explicit
infrastructure criteria accept genuine task FAILURE, so the original grading
FAIL remains visible and unregraded. All twelve durable evidence publications
verified. Native seals found all three owned stacks, ports, databases and volumes
released, all three queues with zero Running workflows, eight exact browser
sessions absent and the exact E2B sandbox absent. The cached nonbrowser stack
allocated no public tunnel. Private receipts remain in
`.context/basic-cli-native-validation-20261006T112941Z/group4-relaunch-20261006T141856Z/`.
These executions close the provider-readiness recurrence; later reporting
producer coverage and the independent fifty-copy campaign remain separate.

## Human feedback

The October 5 standing user instruction requires preserving Freedom and its
blocking configuration. This recurrence must preserve inherited proxy,
resolver and destination policy, including when that route rejects a request.

## Reusable lesson

Verify a tunnel's edge actually routes before returning its URL — treat origin-facing
502/404 as healthy, but persistent HTTP 000 or Cloudflare 530 as dead — and never probe
a rate-limited quick tunnel, since each attempt deepens the limit.
