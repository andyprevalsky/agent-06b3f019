---
id: 2026-10-02-kernel-residential-rotation-redrew-baseline-exit-ip
date: 2026-10-02
title: A fresh Kernel residential session after rotate_ip drew the baseline exit IP and kept it, failing live provider parity
surface: harness
component: browser-provider
classification: third-party-failure
problem_class: other
first_bad_boundary: Kernel managed residential proxy rose-residential-us-ca-san_francisco — the rotated session's exit node was the baseline session's exit node
symptoms:
  - "FAIL live Kernel provider parity: proxy returned unchanged exit IP 89.117.45.54"
  - "browser-provider:exit-ip-change: attempt 2/3 failed, retrying in 1000ms"
tags:
  - browser-provider
  - kernel
  - rotate-ip
  - residential-proxy
  - live-parity
  - deploy-gate
sources:
  - PR #1341
repro: bash back-end/scripts/run-blackbox-tests.sh browser-provider
status: open
---

## Problem

`/deploy` Step 4a (deploy run `20261001-145844-51013`, stage log
`backend-coverage-blackbox-20261002-162241-1114125.log`) failed one of 170
backend blackbox domains. The `browser-provider` live parity case read the
baseline exit IP `89.117.45.54`, called `/api/browser-session/rotate-proxy`, and
then read `89.117.45.54` on all three post-rotation reads (about 3s).

The backend log shows that the rotation itself did its job. The 16:23:08
request ran `Executing browser recovery rotation ... targetProvider=kernel
proxyType=residential`, created session `x36dzj6q8ho61mwyr1d8bpy9`, and returned
200 after 12.6s. The test then asserted a new `session_id`, a new `ws_url`, and
that the superseded session was evicted. All of those passed before the IP read.

No browser, Kernel, or proxy code changed between this run and the previous
Group 3 run, which passed.

## Diagnosis

### Evidence

| Run | Baseline | Rotation 1 (residential) | Rotation 2 (mobile) |
|---|---|---|---|
| Failed coverage run | 89.117.45.54 | 89.117.45.54 on 3 reads | not reached |
| Standalone rerun 1 | 67.188.146.142 | 89.117.45.132 | 75.218.116.102 |
| Standalone rerun 2 | 130.12.17.57 | 99.110.214.18 | 99.18.53.58 |
| Standalone rerun 3 | 69.209.4.98 | 98.51.4.179 | 99.18.53.143 |

Across the 15 recorded runs of this domain plus the 3 standalone reruns, this is
the only failure (1 in 18). Every standalone rotation changed the IP on its first
read. `89.117.45.x` recurs across runs, which is consistent with a small San
Francisco residential pool.

### Root cause

Both sessions use the same project-shared, city-scoped managed proxy. Since
`2026-10-01-shared-kernel-geo-proxy-deleted-downgraded-resume`, test cleanup no
longer deletes it. Kernel assigned the new session the exit node the old session
had. The exit node then stayed fixed for the life of that session: three reads
over about 3s all returned it. The test's same-session retry therefore cannot
recover from a pool collision. Only a new session can.

This was not reproduced on demand. The collision depends on Kernel's pool
assignment, and the three standalone reruns all drew new IPs.

## Solution

The unchanged-IP error now names the rotation stage and the Kernel session id.
The next occurrence then shows directly which tier collided and whether a later
session ever changed.

Still open:
- Production `rotate_ip` does not verify that the exit IP changed. A collision
  spends one ladder step (residential, then mobile, then Steel) on the same IP a
  site may have blocked.
- Whether Kernel residential sessions are sticky per session, and how large the
  San Francisco pool is, is not documented. One collision is not enough to
  decide between "verify and re-create once" and "rotate to a wider geo".

## Human feedback

None recorded.

## Reusable lesson

A live assertion of a provider's random assignment is a probability, not a
contract. Before a gate asserts it, either make the product guarantee it, or
record enough per-read identity to tell a broken rotation from a provider
collision.
