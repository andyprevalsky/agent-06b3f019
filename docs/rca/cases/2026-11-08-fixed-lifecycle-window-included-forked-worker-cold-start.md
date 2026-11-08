---
id: 2026-11-08-fixed-lifecycle-window-included-forked-worker-cold-start
date: 2026-11-08
title: Provider-lifecycle fixture's fixed 10 s windows also timed forked tsx workers' cold start, so host CPU load failed backend-coverage-blackbox
surface: back-end
component: browser-session-provider-lifecycle-fixture
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/tests/blackbox/browser-session-provider-lifecycle.fixture.ts cross-process join step — within(entered) and within(Promise.all([firstWorker.result, secondWorker.result])) started their 10 s clocks at fork(), before each `node --import tsx` worker had compiled and loaded its import graph
symptoms:
  - "Error: provider lifecycle fixture timed out"
  - "at Timeout.<anonymous> (browser-session-lifecycle.fixture-support.ts:16:41)"
  - "Crashed: Error: Command failed: /usr/bin/node --import tsx .../back-end/src/tests/blackbox/browser-session-provider-lifecycle.fixture.ts"
  - "backend-coverage-blackbox / blackbox:browser-session failed in shard-1.log"
tags:
  - browser-session
  - blackbox
  - fixture
  - cold-start
  - tsx
  - host-load
  - deploy-gate
sources:
  - PR #1762 deploy cycle 8 local worker shard-1.log (failed source commit 535b6985a97de5908c5f0a78caced822fafb521c)
  - commit 4a0e080d71e3f8f9972e912d4ecc1c44de7ed6b1 (originating merge, PR #1762)
repro: back-end/src/tests/blackbox/browser-session-provider-lifecycle.fixture.ts (run by browser-session.blackbox.ts via browser-session-provider-lifecycle.cases.ts) under 3 CPU spinners per core
status: fixed
---

## Problem

The PR #1762 deploy ran `backend-coverage-blackbox` locally beside 10 other gate
workers (load ~21 on 8 cores). Shard 1's `blackbox:browser-session` domain crashed
with `Error: provider lifecycle fixture timed out` from the shared `within()` helper
(`browser-session-lifecycle.fixture-support.ts:16:41`, fixed 10 000 ms), in the
provider-lifecycle fixture's cross-process join step (~line 493).

## Diagnosis

The step forks two `node --import tsx browser-session-provider-lifecycle.worker.ts`
processes. The first must reach native allocation (`within(entered)`). The second
must join the same restoration (`within(Promise.all([...results]))`). Both clocks
started immediately after `fork()`. Each worker then loaded and evaluated the
browser-resume import graph through tsx, lazily inside its resume call, and opened
its first Prisma connection there. That startup cost grows with host CPU load, and
it counted against the lifecycle window.

Measured on devbox 53818e5a (8 cores):

- Worker import-graph cold start alone (fork to graph loaded): 2.6–2.8 s ambient,
  9.3 s at 2 spinners/CPU, 10.8 s at 3 spinners/CPU. That exceeds the whole
  window before any lifecycle work.
- Unchanged fixture, instrumented, ambient: `entered` 3.2–3.4 s, join 6.8–8.4 s.
- Unchanged fixture at 3 spinners/CPU: `entered` 7.6 s, then `join FAILED ms=10000`
  with the exact deploy error. Failed 3/3 runs (rc=1 at ~88 s).

The worker timeline on the fixed code shows the remaining in-window work is the
lifecycle under test. The second worker joins 0.2 s after ready. Then the first
worker's allocate + Playwright connect take about 0.27 s, checkpoint storage
restore 0.75 s, tab seeding about 2.4 s and navigation 0.5 s. The deepest owned
cause is a measurement boundary: a fixed deadline meant for a cross-process
restoration also covered process startup, which scales with host load and
belongs to no product path.

## Solution

The worker now loads its import graph (`browserSessionResume`, `lifecycleClaim`)
and awaits `prisma.$connect()` before resuming. It then sends `{ type: 'ready' }` over IPC.
`spawnLifecycleWorker` exposes a `ready` promise. It rejects with the worker's
output if the process exits first, or after a separate 120 s startup bound, so a
hung worker still fails clearly instead of hanging the unbounded fixture process. The fixture starts each fixed 10 s
window only after the worker inside it is ready:
`firstWorker.ready.then(() => within(entered))` and
`secondWorker.ready.then(() => within(Promise.all(...)))`. The timeout value,
assertions and join semantics are unchanged.

After the fix: ambient `entered` 0.5–0.65 s, join 4.5–6.8 s. At 3 spinners/CPU:
4/4 runs pass, with `entered` 0.6–1.3 s and join 5.2–8.6 s. Startup cost (2.6 s
ambient to 10.8 s loaded per worker, measured separately) now runs before the
clock, so total fixture runtime is unchanged. Remaining risk, stated plainly: the
worst loaded join used 86% of the 10 s budget, a 1.4 s margin over only 4 loaded
samples. Most of it is the native tab seeding (~2.4 s ambient), which is the
lifecycle under test. A host much heavier than about 3 runnable threads per core
could still exhaust the window on real lifecycle work. Test-only change. There is
no production or 10k-agent impact.

## Human feedback

None recorded. The repair assignment required keeping the timeout value and
assertions and fixing the measurement instead.

## Reusable lesson

Start a fixed test deadline only after every forked process inside it reports ready, so interpreter and compile cold start under host load never counts against the behavior being timed.
