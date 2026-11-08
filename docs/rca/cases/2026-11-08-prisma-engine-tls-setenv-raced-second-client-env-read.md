---
id: 2026-11-08-prisma-engine-tls-setenv-raced-second-client-env-read
date: 2026-11-08
title: Unit test died silently because the Prisma engine's one-time TLS setenv reallocated environ while a second client read process.env
surface: back-end
component: unit-test-prisma-clients
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/unit/workflow-queue-admission-postgres.test.ts created a second PrismaClient (through the providers/database import) before the first client's connect had finished, so the Prisma library engine's openssl-probe setenv ran concurrently with the main thread's getenv
symptoms:
  - "FAIL  workflow-queue-admission-postgres.test.ts (1948ms)"
  - "1/373 unit test file(s) failed."
  - "Backend test phase failed (blackbox exit 0, unit exit 1)"
  - "Program terminated with signal SIGSEGV, Segmentation fault. __GI_getenv"
tags:
  - prisma
  - native-crash
  - setenv
  - unit-runner
  - deploy-gate
  - observability
sources:
  - PR #1811
  - PR #1775
  - commit cc3642ae2 (failed source)
repro: run the unchanged test file on a private database in a loop with core dumps on (1 SIGSEGV in 1,500 runs here), or a script that does new PrismaClient twice then a first query (3 SIGSEGV in about 2,850 runs); inspect the core with gdb
status: fixed
---

## Problem

`backend-coverage-blackbox` failed on Blacksmith with `FAIL workflow-queue-admission-postgres.test.ts (1948ms)`,
an empty per-file log and no assertion output. The handoff reported 59.7 GB of memory free and 191 passing local
runs. The unit runner recorded neither the child's exit code nor its signal: a signalled child became a bare 128,
so the failure could not be classified. That means the CI failure's signal was never observed; SIGSEGV below is
what the same test does when reproduced locally.

## Diagnosis

Running the unchanged test in a loop, on a private database like the runner uses, with core dumps enabled
reproduced a matching signature: SIGSEGV after 1755 ms with 0 bytes of output, 1 in 1,500 runs. A minimal script
creating two clients then running one query crashed 3 times in about 2,850 runs (stopped by hand, so that count
comes from the last failing run index).

Backtraces were taken from two of the four cores. In both, the main thread is in `getenv` under
`node::RealEnvStore::Get`; the unit test's core shows it reading `PRISMA_QUERY_ENGINE_BINARY`. The core from the
minimal script also caught the writer directly: an engine thread inside `__add_to_environ("SSL_CERT_DIR", ...)`,
with `__environ[0]` holding garbage. The unit test's core shows neither that writer thread nor a corrupt
`__environ[0]`. That the reader is a second client's startup is inferred from the Prisma runtime's engine-path
lookup and from the fix's result, not from a stack frame.

The Prisma 5.22 library engine carries openssl-probe's path table and sets `SSL_CERT_FILE` and `SSL_CERT_DIR`
during its first connect, from an engine thread (`$connect` resolves with both set, per the regression test;
that this happens once per process is expected but untested). Adding a new variable makes glibc reallocate `environ`,
so a concurrent `getenv` on the main thread reads freed memory. A second client's construction reads
`process.env` during its asynchronous engine load, which overlaps the first client's first connect whenever
both clients exist before that connect finishes.

Earlier notes attribute the 2026-10-09 and 2026-11-07 seed-local crashes to the same race; their cores were not
re-examined here. `connectThenOpen`, which applies the same ordering to `seed-local`, merged through PR #1783
shortly before this fix.

## Solution

Connect one client before creating the next, so the one-time write finishes before any other client reads the
environment. PR #1811 applies this to the four multi-client unit files that lacked it
(`workflow-queue-admission-postgres`, `worker-process-recovery-postgres`, `managed-workflow-producers-postgres`,
`unit-runner-database-isolation`).

`run-unit-tests.ts` now records the exit code or signal in the FAIL line, the per-file log and the results JSON.

Regressions, registered in the backend unit suite: `prisma-first-connect-env-probe.test.ts` proves `$connect`
resolves only after the engine's write on Linux and pins connect-first order in every unit file that creates a
PrismaClient; `unit-test-child-exit.test.ts` checks real signalled and non-zero children; `coverage-script.test.ts`
pins the runner wiring.

Evidence after the fix: the two-client repro with connect-first order had 0 SIGSEGV in 9,999 completed runs (a
tenth-thousandth run was excluded: it failed with `PrismaClient is not a constructor` as `prisma generate` rewrote
the client), and the exact test had 0 failures in 1,500 runs. At a 1-in-1,500 rate those 1,500 clean runs alone are
weak evidence, and they ran at 5 workers where the baseline used 7; the repro and the deterministic probe carry the
proof. The Blacksmith gate passed on both tested heads once GitHub downloads worked (a first attempt on the earlier
head never ran its tests because of a GitHub 504).

Still exposed, not changed here: any other process that starts two Prisma clients, namely the backend's own
startup (`providers/database.ts` plus `demoCacheStore.ts`) and multi-client blackbox processes.

## Human feedback

None. This repair ran as an unmonitored `/goal` handoff from the PR #1775 deploy.

## Reusable lesson

A process that dies with no output needs its exit code and signal recorded before anything else; without them a
native crash is indistinguishable from any other failure. In a Node process, a native library that calls `setenv`
from its own thread is unsafe against any `process.env` read. Order startup so that write finishes first, and
verify the ordering's premise with a deterministic check, because the crash itself is too rare to test directly.
