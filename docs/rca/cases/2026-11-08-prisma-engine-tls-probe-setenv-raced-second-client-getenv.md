---
id: 2026-11-08-prisma-engine-tls-probe-setenv-raced-second-client-getenv
date: 2026-11-08
title: seed-local segfaulted (rc 139) after its banner because the Prisma engine's one-time TLS probe setenv()s on an engine thread while a second client's library load reads process.env
surface: back-end
component: seed-local
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/scripts/seed-local.ts constructed `remote` and `local` PrismaClients together at module load; each constructor starts an async engine-library load that reads process.env (PRISMA_QUERY_ENGINE_LIBRARY) on the main thread, overlapping the first connect, whose TLS connector runs openssl-probe and setenv()s SSL_CERT_FILE/SSL_CERT_DIR on an engine thread
symptoms:
  - "run 2: FAILED(rc=139) os_peak=88MB node_peak=0MB worst=- fidelity=not-run"
  - "Command exited with non-zero status 139"
  - "❌ seed memory ratchet requires 5 successful, fidelity-verified runs; got 4"
  - "#0  __GI_getenv (name=0x7ffdf2dc5918 \"PRISMA_QUERY_ENGINE_LIBRARY\") at ./stdlib/getenv.c:31"
  - "RuntimeError: Benchmark run could not refresh local compute tokens"
tags:
  - seed-local
  - prisma
  - segfault
  - getenv-setenv-race
  - openssl-probe
  - seed-memory-ratchet
sources:
  - PR #1783 deploy gate seed-memory-ratchet at ef32d1e0a8 (Blacksmith blacksmith-4vcpu-ubuntu-2404), run 2 of 5 rc 139
  - memory:seed-local-intermittent-segfault (2026-10-09 devbox ratchet run 5; 2026-11-07 cloud guest --compute-tokens-only during the PR #1757 deploy)
repro: bash back-end/scripts/run-blackbox-tests.sh seed-local-user (testLocalClientOpensAfterEngineTlsProbe; fails on the pre-fix seed-local.ts); native repro: 4x250 `/usr/bin/time -v npx tsx scripts/seed-local.ts --compute-tokens-only` with ulimit -c unlimited produced a core at run 68 of lane 2
status: fixed
---

## Problem

The PR #1783 Blacksmith gate `seed-memory-ratchet` ran `bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget`. Run 2
printed the seed banner and died 0.93 s in with `Command exited with non-zero status 139`, and the ratchet refused with
`requires 5 successful, fidelity-verified runs; got 4`. The same crash, at the same point and with the same RSS (~88 MB), hit
the devbox ratchet on 2026-10-09. On 2026-11-07 it hit a cloud guest's `seed-local.ts --compute-tokens-only`, where it became
an INFRA_ERROR that stopped a 10-job smoke campaign. Until now it was recorded as an unreproduced open gap.

## Diagnosis

Native repro: 1,000 runs of `/usr/bin/time -v npx tsx scripts/seed-local.ts --compute-tokens-only` (4 lanes, `ulimit -c
unlimited`, local source and target) produced one rc 139, at run 68 of lane 2, with the identical banner-then-crash log and a core
from the tsx child `node`. Its backtrace (retained evidence `core.1.bt.txt`):

- Thread 1, the JS main thread, was in `__GI_getenv("PRISMA_QUERY_ENGINE_LIBRARY")`, called from `node::EnvGetter`, i.e. a JS
  `process.env` read.
- Thread 13, a query-engine thread, was in `OPENSSL_init_ssl`, called from `libquery_engine-debian-openssl-3.0.x.so.node`.

The engine embeds openssl-probe: its CA search list, then `SSL_CERT_FILE`, `SSL_CERT_DIR` and std's `failed to set environment
variable`. A gdb `break setenv` trace of one fresh Prisma process shows engine thread 19 calling `setenv(SSL_CERT_FILE)` and
`setenv(SSL_CERT_DIR)` on the first TLS connector, even when both are already set to the same paths. So pre-setting them is not
a fix. glibc `setenv` can reallocate `environ` while `getenv` on another thread walks it, which is the SIGSEGV.

A `process.env` proxy shows who reads the variable during the window. `new PrismaClient()` starts `instantiateLibrary`
asynchronously, which reads `PRISMA_QUERY_ENGINE_LIBRARY` again from `loadLibrary`. In the seed's order (construct `remote` and
`local`, then query `remote`), `local`'s asynchronous library load read the environment at +53 ms. That is inside `remote`'s first
connect (+29 ms onward), which is where the engine's one-time TLS probe writes the environment.

First-bad boundary: two clients constructed before the first connect, in our seed. The engine's `setenv` is upstream
(Prisma 5.22 library engine), and we cannot change it in this repo. We can stop running JS that reads the environment while it
happens.

## Solution

`connectThenOpen(first, open)` in `back-end/scripts/seed-local-helpers.ts` awaits `first.$connect()`, which has completed the
engine's one-time probe, before constructing the next client. `seed-local.ts` opens `local` through
`connectThenOpen(remote, ...)` inside `ensureSeedUserExists`, the seed's first read. That keeps an initial connection failure inside
the existing `syncRequiredCredentialTable` retry owner. The finalizer disconnects `local` only if it was opened.

Regression: `testLocalClientOpensAfterEngineTlsProbe` in `back-end/src/tests/blackbox/seed-local-user.blackbox.ts` (backend
blackbox domain `seed-local-user`) spawns `src/tests/fixtures/prisma-open-order.child.ts` with real PrismaClients against the
blackbox database and with `SSL_CERT_FILE`/`SSL_CERT_DIR` removed.

- Control: a client constructed before the first connect is constructed before the engine writes `SSL_CERT_FILE`, and the
  engine does write it.
- `connectThenOpen` constructs the second client only after the write.
- `seed-local.ts` uses `connectThenOpen(remote, ...)` as the first step of its first read.

Red on the pre-fix `seed-local.ts`, green after. `seed-credential-retry` case 5, which runs the real `ensureSeedUserExists`/`sync` in a sandbox, now also extracts `openLocalClient` and binds the real `connectThenOpen` with a no-op `remote.$connect`. Its admission counts and assertions are unchanged; the first gate run on the fix failed it with `ReferenceError: openLocalClient is not defined` until the binding existed. Outcome evidence: the fixed seed ran the same 4-lane `--compute-tokens-only` stress
2,000 times (see the stress receipt in the PR), and the unchanged `seed-memory-ratchet` gate is rerun by the deploy.

Sibling exposure, not changed here: any other Node process that constructs a second PrismaClient while a first is connecting
(for example the backend's main and DEMO-cache clients at startup) has the same window. Apply `connectThenOpen` there if a startup
rc 139 is ever seen.

10k-agent behavior: none. The seed runs once per stack; one extra sequential connect at seed start.

## Human feedback

None recorded.

## Reusable lesson

When a native addon's background thread may call setenv (Prisma's openssl-probe on the first TLS connect), finish that first connect before running JS that reads process.env, because glibc getenv and setenv are not thread-safe against each other.
