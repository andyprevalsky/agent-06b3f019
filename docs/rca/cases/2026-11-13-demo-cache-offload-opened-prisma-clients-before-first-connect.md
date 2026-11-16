---
id: 2026-11-13-demo-cache-offload-opened-prisma-clients-before-first-connect
date: 2026-11-13
title: demo-cache-offload blackbox exited non-zero with no output because it constructed three Prisma clients before the first connect ran the engine's setenv TLS probe; its backfill scan also crossed into other runs' keys
surface: back-end
component: demo-cache-offload-blackbox
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/blackbox/demo-cache-offload.blackbox.ts main() imported demoCacheStore (whose database.ts import constructs the app PrismaClient) and constructed its own db client before any client had connected; the DEMO-cache client's first connect then ran the engine's one-time openssl-probe setenv() while the other clients' asynchronous library loads read process.env
symptoms:
  - "attempt 1 exited non-zero after 1552 ms with no output"
  - "FLAKY demo-cache-offload"
  - "backend-coverage-blackbox/blackbox:demo-cache-offload"
  - "[runner] domain process exited code=null signal=SIGSEGV"
tags:
  - prisma
  - getenv-setenv-race
  - openssl-probe
  - blackbox-runner
  - fast-mode-cache
  - flaky
sources:
  - PR #1910 deploy round 25 backend-coverage-blackbox rca/0d428d7de34f413ea3bfbeb74dabf1ba (failed source 043c9c25419d, merged 7b07d5faf)
  - commit 4c67384926 (connectThenOpen, RCA 2026-11-08-prisma-engine-tls-probe-setenv-raced-second-client-getenv)
repro: bash back-end/scripts/run-blackbox-tests.sh demo-cache-offload (open-order assertion and the neighbor-row assertion, both red on the pre-fix order/scan); runner exit line in back-end/src/tests/unit/gate-progress.test.ts (red on the pre-fix run.ts)
status: mitigated
---

## Problem

In the PR #1910 deploy, the `backend-coverage-blackbox` gate ran the `demo-cache-offload` domain twice. Attempt 1
`exited non-zero after 1552 ms with no output`: no `console.error`, no spans, nothing from the domain's own catch handler.
Attempt 2 passed, so the domain was recorded FLAKY and quarantined under `pending-handoff:0d428d7de34f413ea3bfbeb74dabf1ba`.
The blackbox runner kept only `code === 0` and threw away the exit code and signal, so the record could not say whether the
process crashed natively.

## Diagnosis

A JS failure in this domain always prints: its `main().catch` writes the error with `console.error` before `process.exit(1)`.
A silent non-zero exit at ~1.5 s therefore means the process died without running JS, which is a native crash. That is the
signature in `2026-11-08-prisma-engine-tls-probe-setenv-raced-second-client-getenv`: the Prisma library engine's first TLS
connector runs openssl-probe on an engine thread and `setenv()`s `SSL_CERT_FILE`/`SSL_CERT_DIR` once per process, while a
client constructed earlier reads `process.env` on the main thread during its asynchronous library load (glibc
`getenv`/`setenv` race → SIGSEGV).

The domain had that open order. `main()` imported `providers/demoCacheStore`, whose `./database` import constructs the app
`PrismaClient` eagerly. Then it constructed its own `db` client, and the store's lazy DEMO-cache client made the first
connect. Three clients existed before the probe ran.

Deterministic proof of the precondition (Linux, `SSL_CERT_FILE` unset as on the gate VMs): the domain now asserts that
`SSL_CERT_FILE` has been written by the time the store is imported. With the pre-fix order restored, it fails
(`AssertionError: the engine TLS probe must finish before the store constructs its Prisma clients`, rc 1). With the fix, it
passes. Earlier, about 3,000 local runs per side did not natively reproduce the crash, and neither did this RCA. So the
crash itself is attributed by signature, not observed here. That is why the status is `mitigated`, and why the runner now
records the signal.

Separate defect, same domain: `offloadFastCacheBatch(prefix, 10)` treated the prefix only as a cursor (`key > prefix`),
so the scan continued into later keys. On a shared database it could offload another concurrent run's inline row,
breaking that run's exact-receipt assertion and its own "rerun is a no-op" check. Repro: with a neighbor row
`zz-offload-<hex>x-d` (sorts after this run's keys in both byte and locale order), the unbounded scan reported
`{"scanned":6,"offloaded":2,...}` and failed `dry.offloaded === 1`.

## Solution

- The domain constructs `db` and opens the store only through `connectThenOpen(db, () => import(store))`. Every other
  client is built after the one-time probe, and the domain asserts that order on Linux.
- `offloadFastCacheBatch` accepts `keyPrefix` (`starts_with(key, prefix)`). The domain passes it and asserts that the
  neighbor row's `xmin` is unchanged. The production script's call is unchanged.
- `blackbox/run.ts` appends `[runner] domain process exited code=<c> signal=<s> after <n>ms[ with no output]` to every
  failed attempt, so a recurrence is recorded as SIGSEGV or as an ordinary exit. Regression: `gate-progress.test.ts` case 6,
  where a domain SIGKILLs itself on attempt 1. It fails on the pre-fix runner.
- The quarantine marker was removed after 5 consecutive local runner passes on the fixed source.

Sibling exposure, unchanged: the backend's app and DEMO-cache clients at server startup (see the 2026-11-08 case).
10k-agent behavior: none. This is test-only ordering, plus an optional indexed-range predicate on an operator backfill.

## Human feedback

None recorded.

## Reusable lesson

Connect one Prisma client before constructing any other in a process, including clients created by importing app modules, and make the test runner record a child's exit signal so a silent native crash names itself.
