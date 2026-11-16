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
  - "RERUN: send-sms failed (2422ms); rerunning once"
tags:
  - prisma
  - native-crash
  - setenv
  - unit-runner
  - deploy-gate
  - observability
  - blackbox-runner
sources:
  - PR #1811
  - PR #1775
  - commit cc3642ae2 (failed source)
  - PR #2104 (recurrence, FLAKY fe640f0e, failed source 64ea62ef9b)
repro: back-end/src/tests/blackbox/send-sms.blackbox.ts case 'only the app client exists before the first query' (red at 2 clients pre-fix); originally, run the unchanged test file on a private database in a loop with core dumps on (1 SIGSEGV in 1,500 runs here), or a script that does new PrismaClient twice then a first query (3 SIGSEGV in about 2,850 runs); inspect the core with gdb
status: fixed
---

## Problem

`backend-coverage-blackbox` failed on Blacksmith with `FAIL workflow-queue-admission-postgres.test.ts (1948ms)`,
an empty per-file log and no assertion output. The handoff reported 59.7 GB of memory free and 191 passing local
runs. The unit runner recorded neither the child's exit code nor its signal: a signalled child became a bare 128,
so the failure could not be classified. That means the CI failure's signal was never observed; SIGSEGV below is
what the same test does when reproduced locally.

Recurrence, 2026-11-15 (PR #2104 deploy, FLAKY `fe640f0e71f84ed0b3a7c9857f01ce76`): the `send-sms` blackbox domain
died on attempt 1 with `RERUN: send-sms failed (2422ms); rerunning once`, 0 bytes of output, before its first stdout
line and without its own catch output; attempt 2 passed. The runner at that source recorded no exit code or signal.

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

Recurrence diagnosis (send-sms, 2026-11-15). `send-sms.support.ts` constructed its own `new PrismaClient()` at import,
after its `notificationLlm` import (`../rose` → `computeCredentials`) had already loaded `providers/database.ts` and
constructed the app client; Prisma 5.22's
`LibraryEngine` constructor starts `instantiateLibrary()` at once, so both engines load asynchronously while
`createTestUser()` runs the first connect. A loop of the domain's exact startup (every module `send-sms.blackbox.ts`
imports, in order, then the fixture create/cleanup and disconnect) on the unchanged source crashed natively once in
1,094 runs: rc 139, 0 bytes, 2986 ms. The core's main thread is in `__GI_getenv(name="PRISMA_QUERY_ENGINE_LIBRARY")`
under `node::RealEnvStore::Get`. The writer was not caught (no thread was inside `setenv`), and a heap `__environ` alone
does not prove the engine's write because `dotenv.config()` also adds variables, so the writer is inferred from the
signature, the precondition below and the fix's result. A construction-counting child confirmed the precondition deterministically: 2 clients before the first
query (`providers/database.ts:312`, `send-sms.support.ts:25`). This is the "multi-client blackbox process" exposure
named below; the 2026-11-13 `demo-cache-offload` case was its first blackbox instance, fixed per file.

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

Evidence after the fix: the two-client repro with connect-first order had 0 SIGSEGV in 9,999 completed runs (one
further run was excluded: it failed with `PrismaClient is not a constructor` as `prisma generate` rewrote
the client), and the exact test had 0 failures in 1,500 runs. At a 1-in-1,500 rate those 1,500 clean runs alone are
weak evidence, and they ran at 5 workers where the baseline used 7; the repro and the deterministic probe carry the
proof. The Blacksmith gate passed on both tested heads once GitHub downloads worked (a first attempt on the earlier
head never ran its tests because of a GitHub 504).

Still exposed, not changed here: any other process that starts two Prisma clients, namely the backend's own
startup (`providers/database.ts` plus `demoCacheStore.ts`) and multi-client blackbox processes.

Recurrence fix (send-sms): the support file re-exports the app's `prisma` from `providers/database` instead of building
a second client, so the process holds one client before its first query (deleting the redundant client rather than
ordering two). Regression in the same domain: case `only the app client exists before the first query` spawns
`tests/fixtures/send-sms-prisma-clients.child.ts`, which loads every module the domain imports with construction
counted and must report exactly the `providers/database.ts` client; its control mode builds one extra client and must
count it. Red on the pre-fix source (2 clients), green after (1). The `fe640f0e` quarantine marker was removed after
5 consecutive passes of `bash scripts/run-blackbox-tests.sh send-sms`. The same startup loop on the fixed source:
0 crashes in 3,006 runs (1 in 1,094 before; at that rate 3,006 clean runs alone would
occur about 6% of the time unfixed, so the deterministic count carries the proof). The new case passed 5 consecutive
runs alone and 8 concurrent runs at full CPU load (about 3.7 s against its 120 s limit), and fails on the pre-fix
support file. Still exposed, not changed here: an independent review found five sibling domains that load
`providers/database.ts` and build their own client at import: `send-sms-whatsapp-mirroring.blackbox.ts:20`,
`proactive-sms.blackbox.ts:32`, `sms-webhook.blackbox.ts:55`, `sms-supervisor.blackbox.ts:65` and
`whatsapp-webhook.blackbox.ts:58`. None has an observed failure, the assigned repair is scoped to send-sms, and each
switch changes that suite's client semantics (query retry) and needs its own domain validation; the fixture child's
construction count extends to them. 10k-agent behavior: none, test-only.

## Human feedback

None. This repair ran as an unmonitored `/goal` handoff from the PR #1775 deploy.

## Reusable lesson

A process that dies with no output needs its exit code and signal recorded before anything else; without them a
native crash is indistinguishable from any other failure. In a Node process, a native library that calls `setenv`
from its own thread is unsafe against any `process.env` read. Order startup so that write finishes first, and
verify the ordering's premise with a deterministic check, because the crash itself is too rare to test directly.
