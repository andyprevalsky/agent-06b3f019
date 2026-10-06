---
id: 2026-07-10-macos-system-https-proxy-hangs-python-ssl-tunnels
date: 2026-07-10
title: Freedom.app's macOS system HTTPS proxy silently hung every Python SSL tunnel in the benchmark harness
surface: harness
component: local-benchmark-runner
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Python's getproxies_macosx_sysconf picked up HTTPSProxy 127.0.0.1:7769 (FreedomProxy) and blocked forever inside the SSL read
symptoms:
  - benchmark process alive at 0.6-2% CPU with no output and no artifacts
  - WMH rose-archive build hung 10 minutes in "_ssl__SSLSocket_read→poll" and otel/ stayed 0B
  - single ESTABLISHED connection to 127.0.0.1:7769
tags:
  - macos
  - proxy
  - python-ssl
  - benchmarks
  - hang
sources:
  - memory:project_freedom_proxy_stalls_benchmarks
repro: none-recorded
status: fixed
---

## Problem

While verifying the party benchmark slice, the WMH `rose-archive` build hung for
10 minutes with no output: the process was alive but burning 0.6-2% CPU, `otel/`
stayed at 0 bytes (stuck in the fetch phase), and the only network activity was a
single ESTABLISHED connection to `127.0.0.1:7769`. The stack showed it parked in
`_ssl__SSLSocket_read → poll`.

## Diagnosis

Freedom.app (a distraction blocker) runs `FreedomProxy -port 7769 -rpcport 7770`
and sets the **macOS system HTTPS proxy** to `127.0.0.1:7769` (`scutil --proxy`
shows `HTTPSEnable 1`, `HTTPSProxy 127.0.0.1`, `HTTPSPort 7769`). Python HTTP
clients — `requests` and `urllib` via `getproxies_macosx_sysconf` — read that
system setting automatically and tunnel through the proxy, where they block
indefinitely on the SSL read. Plain `curl` through the same proxy works (Anthropic
401, R2 400, both sub-200ms), so this is a Freedom↔Python-SSL-tunnel
incompatibility, not a hard block. The owned gap: the benchmark wrappers inherited
ambient machine proxy configuration for their own infrastructure calls, so a
user-installed app could silently wedge the harness with no error and no timeout.

## Solution

Make the benchmark subprocess bypass the proxy rather than touching the user's
app: `export NO_PROXY='*' no_proxy='*'` and `unset HTTP_PROXY HTTPS_PROXY
ALL_PROXY http_proxy https_proxy all_proxy`. Verified:
`requests.should_bypass_proxies(url, no_proxy='*') == True`, urllib reaches
Anthropic in 0.17s, and the build's connection flips to a direct public IP
(R2 = Cloudflare 172.64.66.x:443). Baked into `scripts/run-party-slice.sh`
immediately after the `.env` load; any future local benchmark or agent wrapper
making direct HTTPS calls on this machine needs the same bypass. Detection
one-liners: `scutil --proxy | grep -i httpsproxy` and
`lsof -nP -iTCP:7769 -sTCP:LISTEN`.

## Human feedback

The human's constraint shaped the fix: do NOT disable or kill the user's
Freedom.app — the harness must work around the machine's proxy configuration, not
change the user's environment.

## Reusable lesson

A local process that is alive, near-0% CPU, and producing nothing is a blocked
socket — check `scutil --proxy` for a system HTTPS proxy and force `NO_PROXY='*'`
in harness subprocesses instead of changing the user's machine.


## October 5, 2026 recurrence and standing instruction

The current standing user instruction forbids bypassing Freedom, including
removing inherited proxy settings or adding global proxy exceptions. The July
solution above records the historical investigation; its bypass recommendation
is superseded by that instruction. Local benchmark children now preserve all
configured and absent inherited proxy variables.

The first deployment unit tail found two tests still expecting the historical
bypass (118 passed, two failed). Updating the same three owning tests to check
configured and absent proxy inheritance, unchanged caller input, Python proxy
discovery, and the real streamed child produced three passes in 1.05 seconds.
The complete standard unit tail then passed all 120 tests in 36.48 seconds and
the preserved composite agents coverage passed its normal threshold. No Freedom
settings or production timeout changed; the original failed tail is retained.

The October 6 main integration also imported a public browser smoke that passed
`--noproxy '*'` to its external request. The existing routing suite's case 13
was extended to require all eight inherited proxy variables and reject proxy,
resolver, and destination overrides. Against the unchanged smoke it failed its
existing app-shell success case. Removing only the bypass restored all 21
existing routing checks, including the browser User-Agent, exact HTTP 200,
app-shell marker, and failing 511/200 interstitial inverses. Independent review
approved the two-file repair. The original failed log and successful rerun are
private; this routing finding is not attributed as the cause of the separate
Hub SQL admission failure and earns no fleet speedup credit.

The October 6 durable-evidence publication preparation found another inherited
bypass before any publication request was made: `publish_evidence_links.py`
constructed an empty `ProxyHandler` for every request, including external Hub,
frontend, and recording URLs. This finding does not establish a transport
failure or explain the separate Hub admission failure. The completed smoke
(8/8, 1065.305 seconds) and AgentCard sandbox (4/4, 899.107 seconds) runs retain
their original source and cleanup receipts.

The existing automatic browser-validation suite now exercises the actual opener
and recording probe through an in-memory terminal HTTP/HTTPS transport. Against
the unchanged publisher, six external GET/POST routes ignored the configured
proxy, including a `localhost.external.invalid` inverse; three exact loopback
routes and a configured external proxy exception passed. The permanent control
failed in 0.078 seconds. An initial URL-scoped repair passed the same ten route
assertions and full browser owner in 0.636 seconds. Independent review then
followed a real urllib 302 redirect from loopback to an external recording URL:
the initial opener retained its direct transport for the redirected request.
The permanent redirect inverse failed in 0.065 seconds, then the same owner
passed in 0.638 seconds after moving exact-loopback handling into the standard
configured `ProxyHandler` on each request. All other requests, including
redirects, delegate to ordinary proxy discovery and configured exceptions.

The normal publisher's adjacent session verifier had the same external bypass.
Its actual verification request failed the expanded owning control in 0.067
seconds before correction. The same automatic browser owner now checks that
verifier's response extraction, external and exact-loopback routes, configured
exception, and real redirect; the existing durable owner, including composite
projection, passed in 1.173 seconds. These synthetic transport controls made no
outbound request and preserved all eight proxy environment values, including
absence. No Freedom, task, model, evaluator, or execution-budget setting changed.

All four actual AgentCard roots were published through the normal CLI in
36.020 seconds, with fresh-browser transcript, status, recording, and HTTPS dump
verification. Their publication receipts retain the initial repair's source
hash: each actual request began at an external URL and used ordinary proxy
routing; the later loopback-redirect defect was not on those paths. No
publication was repeated merely to change its source hash. Signing parameters
remain private, while safe receipts contain canonical agent-ID URLs and dump
hashes. Durable links still require the normal publisher's actual renderer,
status, and recording checks.
