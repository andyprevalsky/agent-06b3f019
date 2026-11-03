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
  - long-task-stall warning on a page that blocks in gl.readPixels or a sync XHR
tags:
  - rose-ui
  - flaky-test
  - chromium
  - long-task
  - performance-budget
sources:
  - commit e688a08be
  - commit 189cdd6c5
  - PR #1592
repro: back-end/src/tests/unit/rose-ui-cli-budgets.test.ts ("long-task: page CPU or page-made blocking calls fail; host stalls fail unless a second window is clean"); back-end/src/tests/unit/rose-ui-cli-browser.test.ts ("check fails a one-off blocking GPU readback on long-task", "check --examples passes every shipped example")
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
a stopped process. Those stalls are not the page's work. A blocking call the page
makes itself (sync XHR, GPU readback) also shows low CPU, but it is the page's
work; the PR #1592 review found that the first two fixes excused it.

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

`measureRoute` traces each steady window with Chromium's `toplevel`,
`devtools.timeline` and `v8.execute` categories (`tracedWindow`). On Linux it
also samples each renderer main thread's scheduler state from
`/proc/<pid>/task/<pid>/stat` about every 2 ms (`startThreadSampler`). The
sampler uses the trace clock, CLOCK_MONOTONIC.

For each renderer main-thread `ThreadControllerImpl::RunTask`,
`traceMainThreadTasks` reports three values:

- wall time (`dur`);
- thread CPU time (`tdur`); a missing `tdur` makes the check fail loudly;
- `pageWait`: sampled time the thread slept voluntarily (state S) while page
  script (`FunctionCall`, `EvaluateScript`, ...) was running. This is a blocking
  call the page made, such as a GPU readback or a sync XHR.

A host stall is involuntary: the thread is runnable but descheduled (R), in a
page fault (D) or stopped (T).

`evaluateBudgets` fails `long-task` at once when CPU plus `pageWait` exceeds
50 ms. The rest of the wall time is host-imposed. For such a task `check`
measures a second traced window (`longTaskRecheck`):

- If any wall-time long task recurs, the check fails. This keeps the janky
  fixture's wall-clock busy-wait failing on a loaded host.
- If none recurs, the task becomes a `long-task-stall` warning.
- Without thread samples (not Linux, or the samples don't cover the task) or
  without a recheck, the task is judged on wall time.

The 50 ms limit is unchanged.

History:

- The first candidate judged on CPU time alone. An adversarial review rejected it
  because it excused page-caused waits and made janky detection depend on load.
- The recheck version still excused a one-off page wait. CodeRabbit raised this
  on PR #1592. A fixture doing one blocking `gl.readPixels` after a heavy
  SwiftShader draw (1251 ms wall, 0.4 ms CPU) passed `check` on that revision
  with only a warning. With `pageWait` it fails (`pageWait` 1245.5 ms).

The 130 ms SIGSTOP injection still records about 130 ms wall, under 1 ms CPU and
a `pageWait` of 0, so it remains a warning.

Regressions:

- **Budgets unit test** (`rose-ui-cli-budgets.test.ts`) covers stall, page wait,
  recurrence, missing evidence, CPU-heavy work, and trace and sample parsing. It
  fails on the CLI from before each fix.
- **Browser test:** "check fails a one-off blocking GPU readback on long-task"
  uses `fixtures/user-ui/blocking`. It fails on the previous revision.

Both run in the backend `npm run test:coverage` deploy gate.

At 10k agents, the cost per measured route on the agent's own sandbox browser is:

- one trace;
- a 2 ms `/proc` read per renderer main thread during the window;
- one extra 2 s window only when a host-stalled long task was seen.

No shared state is added.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Judge per-task performance budgets on the thread's CPU time, not wall-clock duration, because host stalls inflate wall time without any page work.
