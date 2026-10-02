---
id: 2026-10-01-shared-kernel-geo-proxy-deleted-downgraded-resume
date: 2026-10-01
title: The live Kernel parity test deleted the project-shared geo proxy, and the proxy ladder treated the deleted ID as missing inventory and downgraded resume from city to state
surface: back-end
component: browser-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: kernelProxy.ts / kernel.ts managed-proxy ladder — a `400 proxy not found` for a cached proxy ID relaxed city → state instead of re-resolving the same geo; browser-provider.live.support.ts cleanup deleted the shared `rose-residential-us-ca-san_francisco` proxy in the prod Kernel project
symptoms:
  - "FAIL live Kernel provider parity: resume lost resolved proxy fallback metadata"
  - "Kernel proxy location unavailable; relaxing location specificity proxyKey=residential:US:CA:san_francisco error=400 proxy not found"
  - resume proxy_source kernel_residential_state after init kernel_residential_city
tags:
  - deploy
  - blackbox
  - kernel
  - browser
  - proxy
sources:
  - PR #1364
repro: back-end/src/tests/unit/browser-proxy-rotation.test.ts
status: fixed
---

## Problem

`/deploy` Step 4a failed only in `browser-provider`: "live Kernel provider parity: resume lost resolved proxy fallback metadata". The same domain had passed in three earlier lanes on the same branch.

## Diagnosis

The backend log shows init at 23:30:49 resolving the San Francisco residential proxy. At 23:31:26, during resume, Kernel rejected that same cached proxy ID with `400 proxy not found`, so the ladder relaxed to the state-level proxy and resume reported `kernel_residential_state`. The local cache now held a fresh `residential:US:CA` row created at 23:31:26.892, and the city row was gone.

Managed geo proxies are shared by name across the Kernel project (`getOrCreateKernelProxy` reuses them through the cache row or `proxies.list`), and the blackbox `KERNEL_API_KEY` is the prod Kernel key (same SHA-256 as Render's). The parity test's `finally` block called `DELETE /proxies/<id>` on the proxy its session used. Any concurrent run, on another VM, in CI, or in prod, that had resolved the same first-listed SF proxy lost it mid-flight. Prod sessions with a cached ID hit the same downgrade the next time they started.

The product half: the ladder treated every availability error alike. `proxy not found` means this cached ID was deleted, not that the city has no inventory, yet it relaxed specificity anyway, silently giving the user a coarser geo. The project also holds about 2,300 duplicate `rose-*` proxies (790 for Palo Alto, 397 for Dallas, 268 for San Francisco). These are leftovers from before list-reuse landed and were not touched here.

## Solution

`createSessionOnKernelProxyLadder` (in `kernelProxy.ts`, used by `kernel.ts`) is the city → state → country ladder. On `proxy not found` for a resolved proxy it forgets the stale cache row and re-resolves the same candidate once (reuse a listed live proxy, or create one) before relaxing. Other sticky errors and timeouts behave as before. Refreshes log `Kernel proxy was deleted; re-resolving the same location`.

The live test no longer deletes the managed proxy. The cleanup helper is now `deleteKernelProfile`, so no shared-proxy delete helper is left. A new live leg, `browser-provider-stale-proxy.support.ts`, creates a uniquely named private proxy that no other run can resolve, points the city cache row at it, deletes it between pause and resume, and asserts that resume keeps the city source and location on a new proxy ID.

Repro: the new case in `browser-proxy-rotation.test.ts` fails on the extracted pre-fix ladder with `resume lost the city proxy` (`kernel_residential_state` vs `kernel_residential_city`) and passes with the fix. The same case also pins down that a second refresh is not attempted and that timeouts keep the cache row.

## Human feedback

None recorded.

## Reusable lesson

A resource that is shared by name across environments (prod, CI, every concurrent run) is not owned by the test that happened to resolve it, so test cleanup must never delete it. When a cached remote ID fails with "not found", refresh the same request before degrading it; that error says the cache is stale, not that the resource class is unavailable.
