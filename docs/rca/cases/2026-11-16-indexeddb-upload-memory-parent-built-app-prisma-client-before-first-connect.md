---
id: 2026-11-16-indexeddb-upload-memory-parent-built-app-prisma-client-before-first-connect
date: 2026-11-16
title: indexeddb-upload-memory blackbox died silently at 813 ms because its static uploadService import built the app PrismaClient before the file's own client ran the engine's first-connect setenv TLS probe
surface: back-end
component: indexeddb-upload-memory-blackbox
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts statically imported domains/integrations/uploadService (whose providers/database import constructs the app PrismaClient) and then constructed its own PrismaClient at module load; the parent's first query (cleanupUser) ran the Prisma engine's one-time openssl-probe setenv(SSL_CERT_FILE/DIR) on an engine thread while the app client's asynchronous engine construction read process.env on the main thread
symptoms:
  - "RERUN: indexeddb-upload-memory failed (813ms); rerunning once"
  - "FLAKY indexeddb-upload-memory"
  - "backend-coverage-blackbox/blackbox:indexeddb-upload-memory"
  - "repair=pending-handoff:27bccbe224b44535a662b172d1f728c3"
tags:
  - prisma
  - getenv-setenv-race
  - openssl-probe
  - blackbox
  - flaky
sources:
  - PR #2104 deploy round 6 backend-coverage-blackbox FLAKY occurrence 27bccbe224b44535a662b172d1f728c3 (failed source 2d1c94c461, merged 31641a6709)
  - commit d7dbd7abc3 (connect-first order for unit files, RCA 2026-11-08-prisma-engine-tls-setenv-raced-second-client-env-read)
  - commit 98dbf6e190 (connectThenOpen in a blackbox, RCA 2026-11-13-demo-cache-offload-opened-prisma-clients-before-first-connect)
repro: bash back-end/scripts/run-blackbox-tests.sh indexeddb-upload-memory (case "no other Prisma client starts before this file's first connect" is red when a static uploadService import is restored, green on the fix)
status: mitigated
---

## Problem

In the PR #2104 deploy (round 6, `backend-coverage-blackbox`, shard 1), the `indexeddb-upload-memory` domain's first
attempt failed after 813 ms with 0 bytes of output: no JS stack, no V8 `FATAL ERROR`, no fixture line. The rerun passed
10/10, so the occurrence was FLAKY (`27bccbe224b44535a662b172d1f728c3`) and the domain was quarantined NOT_INTRODUCED:
`git diff 42042f7318..2d1c94c461 -- back-end/` is empty. Only the occurrence JSON survived (`detail: ""`); the
per-domain log stayed on the originating devbox, so the exit signal was never recorded.

## Diagnosis

Archive searches: `indexeddb-upload-memory failed 813ms rerunning once` (hit: the 2026-10-01 fixture/Postgres OOM case,
which kills Postgres after the fixture build starts, not a silent parent at 813 ms) and `prisma setenv SSL_CERT_FILE
second PrismaClient SIGSEGV getenv` (hits: the 2026-11-08 unit case and the 2026-11-13 demo-cache-offload blackbox case).
This incident is a recurrence of the 2026-11-08 class in a file that fix never covered. Its lesson applies directly.

Timeline in main's parent process: the static imports run first, and `uploadService` → `providers/database` constructs the
app client. Prisma 5.22's `LibraryEngine` constructor starts `instantiateLibrary()` asynchronously; that reads
`PRISMA_QUERY_ENGINE_LIBRARY` and later copies `process.env` into the engine constructor. The module body then constructs
the file's own `prisma`, and `main()` → `cleanupUser()` makes the process's first connect. During that connect an engine
thread calls `setenv("SSL_CERT_FILE")` and `setenv("SSL_CERT_DIR")` once (openssl-probe; glibc reallocates `environ`).
At 813 ms a silent death fits that window: the fixture build, which prints the first line, starts only after it.

Repro (local, Linux, `SSL_CERT_*` unset like the gate VMs). The Prisma engine is `dlopen`ed with `RTLD_DEEPBIND` and
reaches `setenv` through a `GLOB_DAT` GOT slot (`readelf -r`: `0x1162cf8 setenv@GLIBC_2.2.5`). So `LD_PRELOAD` and
`la_symbind` both miss it. An `LD_AUDIT` detector therefore rebinds Node's `getenv` and patches the engine's
`setenv` slot. It widens the engine-thread write by 300 ms and records every main-thread `getenv` made inside it. With
the main thread slowed by 100 µs per `getenv`, to simulate a CPU-starved gate VM, the real blackbox file was run:

- origin/main's file: in 2 of 14 runs, the main thread read `PRISMA_QUERY_ENGINE_LIBRARY` and then the entire environment
  twice (about 400 `getenv` calls) inside the engine's `setenv(SSL_CERT_FILE)`. That is a second client's engine
  construction racing the first connect.
- fixed file: 0 of 13 runs had any `getenv` inside the write.
- 3,000 unwidened runs of a startup-only script in main's order (import uploadService, `new PrismaClient`, first query,
  7 workers) never crashed. A native SIGSEGV was seen once, under an earlier tracing variant of the detector, right after
  it recorded the same `PRISMA_QUERY_ENGINE_*` reads inside the write. That variant also crashed the fixed file before the
  engine loaded, so it does not count as evidence. The native crash on the gate is attributed by signature and by the
  observed overlap, which is why the status is `mitigated`.

Why it was possible: the 2026-11-08 fix pinned connect-first order only for unit files
(`prisma-first-connect-env-probe.test.ts` scans `src/tests/unit/`). The 2026-11-13 fix covered one blackbox file. No
guard covers other blackbox entrypoints that import an app module next to their own client.

## Solution

- `indexeddb-upload-memory.blackbox.ts` no longer imports `uploadService` statically. Its local
  `ingestIndexedDBUploadJson` opens the module once through `connectThenOpen(prisma, () => import(uploadService))`.
  The file's own client connects (so the probe has run) before the app client exists. This holds in the parent and in
  `--child`; `--control` and `--print-*` never load it. Children inherit `SSL_CERT_*` from the parent and do not probe.
- New case `no other Prisma client starts before this file's first connect`: the app client must not exist on
  `globalThis` after every static import has run, must exist after the lazy import, and on Linux `SSL_CERT_FILE` must
  already be set when the import runs. With a static `uploadService` import restored it fails (`10/11 passed`); the fix
  passes 11/11.
- The control-OOM and treatment heap assertions, the 256 MB child heap and every other case are unchanged. The
  `pending-handoff:27bccbe2…` quarantine marker was removed after 5 consecutive passes of the original command on the
  fixed source.

Sibling exposure, unchanged and outside this repair's assigned scope (found by the independent reviewer):
`granola-mcp.blackbox.ts` imports `providers/database` and builds a second client in a helper (line 64), and
`whatsapp-webhook.blackbox.ts` builds its own client at module load (line 58) beside app imports. Neither has failed this
way on record. The class-wide guard would extend `prisma-first-connect-env-probe.test.ts`, which scans only
`src/tests/unit/`, to blackbox entrypoints. The blackbox runner also kept no exit signal for this attempt: the published
attempt-1 log is empty. 10k-agent behavior: none; this is test-only ordering.

## Human feedback

None recorded.

## Reusable lesson

A blackbox entrypoint that needs its own PrismaClient must not statically import any module that builds the app client.
Connect the file's client first, then import the app module (`connectThenOpen`), and assert that order in the file.
