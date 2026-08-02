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
