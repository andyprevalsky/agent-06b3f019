---
id: 2026-10-26-rose-ui-long-task-judged-host-inflated-wall-time
date: 2026-10-26
title: rose-ui check failed shipped examples on long-task because it judged wall-clock task time that host stalls inflate
surface: back-end
component: rose-ui-cli
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/assets/user-ui/bin/rose-ui.cjs evaluateBudgets judged steady-window longtask entries from roseFrameProbe's PerformanceObserver, whose duration is wall-clock time
symptoms:
  - 'agent-dashboard: [{"rule":"long-task","message":"1 main-thread task(s) over 50 ms while running (max 141 ms)","value":141,"limit":50}]'
  - "1 main-thread task(s) over 50 ms while running (max 134 ms)"
  - "check --examples passes every shipped example"
  - rose-ui-cli-browser.test.ts fails intermittently in backend coverage (npm run test:coverage)
tags:
  - rose-ui
  - flaky-test
  - chromium
  - long-task
  - performance-budget
sources:
  - commit e688a08be
repro: back-end/src/tests/unit/rose-ui-cli-budgets.test.ts ("long-task judges main-thread CPU time, so a host stall of the renderer is not a page defect"); browser path back-end/src/tests/unit/rose-ui-cli-browser.test.ts "check --examples passes every shipped example"
status: fixed
---

## Problem

`rose-ui check --examples` (backend unit test `rose-ui-cli-browser.test.ts`)
intermittently failed a shipped example on `long-task`, for example
`agent-dashboard: 1 main-thread task(s) over 50 ms while running (max 141 ms)`.
It failed once in a deploy coverage rerun and once in two standalone runs (host
load 2.2 on 8 cores). Natural reproduction was rare: 0 of 32 local runs
(15 plain, 12 traced and 2 core-pinned busy runs of agent-dashboard, plus 3 full
examples runs) produced any steady long task.

Chromium traces of agent-dashboard's 2 s steady window show the page's own tasks
at 0.7-5 ms (demo tick at 1800 ms intervals; first render at 600 ms precedes the
window). Under 2-core pinned contention, the largest tasks were 25 ms wall but
0.7 ms thread CPU time. The example does not block the main thread.

## Diagnosis

The probe's `longtask` PerformanceObserver reports wall-clock duration.
`evaluateBudgets` failed any steady task over 50 ms. Wall time includes intervals
in which the host stops a running renderer task: preemption, major page faults or
a blocked synchronous IPC. Those stalls are not the page's work.

Reproduction: a scratch injector (not checked in) sent SIGSTOP for 130 ms to the test's own renderer
processes after their main thread entered state R, simulating a host stall of a
running task. On the unchanged command
`cd back-end && npx tsx --test --test-name-pattern "check --examples" src/tests/unit/rose-ui-cli-browser.test.ts`
the base revision failed in 5 of 5 valid runs. Failures included
`agent-dashboard ... while running (max 131 ms)` and `media-menu`/`rose-os ... (max 130 ms)`.
A first injector variant with random timing also failed `wasm-viz (max 133 ms)`.

A control experiment showed that host-page script blocking the shared main thread
for 120 ms produced no `longtask` entry in the user frame. Host scripts are
therefore not the source; stalled tasks within the frame are.

Ladder: (1) The rule failed a page for a wall-clock interval it did not spend
working. (2) The measurement had no way to tell CPU work from waiting, so the rule
the sibling test calls load-independent was load-dependent. (3) The next rung
would require a host with no stalls, which is outside our control. Stop at (2).

## Solution

`measureRoute` traces each steady window using Chromium's `toplevel` category
(`tracedWindow`). `traceMainThreadTasks` reads each renderer main-thread
`ThreadControllerImpl::RunTask` event, recording wall time (`dur`) and thread
CPU time (`tdur`). A missing `tdur` fails loudly. `evaluateBudgets` judges
steady tasks as follows:

- **Over 50 ms of CPU:** fails `long-task` immediately. This is the page's own
  work.
- **Over 50 ms of wall time with no more than 50 ms of CPU:** this is ambiguous.
  The host may have stalled the renderer, or the page may be blocking on a wait
  such as GPU readback on SwiftShader or a synchronous XHR. `check` measures a
  second traced window (`longTaskRecheck`). If any wall-time long task appears
  again, the entry fails. If none appears, it passes with a `long-task-stall`
  warning. Without a recheck or a CPU figure, wall time is judged as before.

A stall the host imposes once does not recur in the second window. A wait the
page repeats does recur. This includes the janky fixture's wall-clock busy-wait
on a loaded host, where its CPU per task can fall below 50 ms. The 50 ms limit is
unchanged, and load-phase warnings still come from the in-frame observer.

The first candidate judged on CPU time alone. An adversarial review rejected it
because it would excuse page-caused blocking waits and make janky detection
depend on host load. The recheck was added in response.

With the fix, the same stall injection records agent-dashboard at 130.7 ms wall
and 0.6 ms CPU, and the verdict passes. The budgets unit regression covers five
cases: a stalled task as a warning, a recurring wait as a failure, a
not-rechecked or CPU-less task as a failure, CPU-heavy work as a failure, and
trace parsing including the missing-CPU error. It failed against the base CLI.
Both the unit test and the browser test run in the backend
`npm run test:coverage` deploy gate.

At 10k agents, the cost is a trace for each measured route on that agent's own
sandbox browser, plus one extra 2 s window only when a wall-only long task was
seen. No shared state is added.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Judge per-task performance budgets on the thread's CPU time, not wall-clock duration, because host stalls inflate wall time without any page work.
