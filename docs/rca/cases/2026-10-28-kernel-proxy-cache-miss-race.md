---
id: 2026-10-28-kernel-proxy-cache-miss-race
date: 2026-10-28
title: Concurrent Kernel proxy cache misses provisioned duplicate configurations and permission errors relaxed geography
surface: back-end
component: browser-kernel
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: getOrCreateKernelProxy performed remote creation before atomically coordinating a cache miss
symptoms:
  - Six concurrent cache misses made six remote proxy creations
  - "pingproxy: unexpected status 403"
tags:
  - kernel
  - proxy
  - concurrency
  - permissions
sources:
  - PR #1634
repro: back-end/src/tests/unit/kernel-proxy-concurrency.test.ts
status: fixed
---

## Problem

Production already reused Kernel proxy IDs from the database, then searched
remote matching configurations on a miss. Multiple processes could nevertheless
observe the same miss and all create a proxy before the unique database row
selected one winner. Separately, the generic configuration-validation error
classifier treated an upstream permission denial as missing geographic capacity.

## Diagnosis

The regression starts six independent Node processes against one owned local
Postgres database and a fake provider that records POST requests. Each process
observes a cache miss before any proceeds. On the original implementation,
there were six remote creates rather than one. The permission regression used
the observed HTTP 400 containing `pingproxy: unexpected status 403` and proved
that the old classifier incorrectly returned geographic availability failure.

Archive searches used `pingproxy unexpected status 403` and
`proxy duplicates cache concurrent treasury mint unresolved`. Related stale-ID
and proxy-health cases were leads, not proof of this race.

## Solution

Coalesce matching in-process requests. Coordinate cache fills with a PostgreSQL
transaction try-lock, recheck the cache under that lock, and retain exact remote
name/type/config lookup before creating anything. Try-lock losers release their
connection before waiting; only one cache fill holds a connection over remote
I/O. Native upsert retains a row inserted by an older deployment instance without
aborting the transaction or deleting the shared proxy. The wait budget uses the
existing proxy-operation timeout.

Permission denials now propagate before health-based cache eviction or geographic
fallback. They are not converted to absent city inventory.

## Validation

With local DATABASE_URL and DIRECT_URL selected,
`timeout 60s node_modules/.bin/tsx back-end/src/tests/unit/kernel-proxy-concurrency.test.ts --concurrency`
fails on the original source and passes on the fix. The same command with
`--permission` fails before the fix and passes afterward. The coordinator also
ran the complete test without flags against the owned
`victoria_cloud-77932055` database; all groups passed. Coverage includes six processes sharing one remote
allocation, same-process callers sharing a failed attempt, later successful retry,
a mixed-version insertion winner, and permission failure preserving cached state.
The existing browser proxy rotation regression also passes. Evidence:
`/var/tmp/kernel-proxy-old-concurrency.log`,
`/var/tmp/kernel-proxy-old-permission.log`, `/var/tmp/kernel-proxy-new.log`,
`/var/tmp/kernel-proxy-rotation.log`, and
`/var/tmp/rose-kernel-final-owned-db.log` on the investigating machine.

The lock coordinates a shared database, not independent benchmark databases.
Remote configuration lookup still reduces duplication across isolated databases.
Different-key cache fills serialize deliberately to bound connections held over
provider calls; ordinary cache hits do not take the lock.

The live provider failure remains separate and unresolved: at 2026-10-28T22:20:43Z,
a single disposable mobile proxy creation using an existing available US
configuration returned the same upstream 403. No proxy was created. Existing
residential and mobile configurations had worked in the earlier parity test.
This change does not claim to restore upstream permission or clear that gate.

## Human feedback

The user asked whether proxies should be reused and then authorized fixing all
remaining issues and including them in PR #1634.

## Reusable lesson

A unique cache row only chooses a winner after external effects have happened.
Coordinate cache misses before provisioning, and keep authorization failures
separate from geographic inventory failures.
