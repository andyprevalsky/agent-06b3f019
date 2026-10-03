---
id: 2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget
date: 2026-10-02
title: A host-load renderer stall consumed the browser-chip-count spec's 30s client-side poll before any value was observed
surface: harness
component: semantic-playwright-suite
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: front-end/tests-e2e/browser-chip-count.spec.ts expectChipCount after page.reload — a client-side expect.poll over locator.count() charged a probe stuck in a frozen renderer against its 30s wall-clock budget, on a deploy gate that launches a fixed four Chromium workers regardless of host headroom
symptoms:
  - "after reload: browser chip count never reached 0"
  - "Timeout 30000ms exceeded while waiting on the predicate"
  - "Agent channel (agent:...) status: TIMED_OUT"
  - "RENDERER UNRESPONSIVE: page probe"
  - "direct_answer sample 5 exceeded the full-lifecycle ratchet"
tags:
  - playwright
  - semantic-gate
  - host-load
  - renderer-stall
  - expect-poll
  - flaky-test
  - deploy-gate
sources:
  - agent 711380f0-2698-4707-a463-e44c2d077d62
  - memory:project_deploy_host_contention_blockers
repro: scripts/semantic-renderer-stall.py
status: mitigated
---

## Problem

During the /deploy semantic gate (4 Playwright workers, host load average ~56 on
14 cores), `browser-chip-count.spec.ts` failed at line 168: `after reload:
browser chip count never reached 0` / `Timeout 30000ms exceeded while waiting on
the predicate`. Every realtime step before the reload passed (2 → 1 → 0 → 1 → 1 →
0 chips). A solo rerun passed in 22.5s.

Trace evidence (trace-relative ms):

- Hydration data was complete. `GET /api/agents/711380f0-…` at 21:59:14.2
  (431ms, `has_more=false`) returned all 10 messages in order, including all three
  terminals: task-scoped `task_complete` for `chip-task-a`, the tool-call-scoped
  ERROR for `call-chip-b`, and `task_complete` for `retry-task-new`.
- The only `chips.count()` probe after the reload started at 38080 and returned
  `0` at 72896 (34.8s). `expect.poll` failed at 68088 with that probe still in
  flight. No chip was ever rendered after the reload, and the error-context DOM
  shows three terminal "Browser Agent" cards and no chip.
- The page was frozen from about 38.6s to 72.8s:
  - no screencast frames between 40916 and 72774, and no console output;
  - the backend received no request from the page between 21:59:15.73 and
    21:59:49.66, although the page normally polls every 10s;
  - realtime subscribe timers fired late (`TIMED_OUT` at 72.8s);
  - frames at 38.6s and 40.9s still show the pre-hydration landing page, and the
    frame at 72.8s shows "Loading AI Network".

**Recurrence (same day, 23:37Z, `chat-lifecycle-latency.spec.ts` direct_answer
sample 5, 1 worker, load1 ~62):** `first-response=7523ms lifecycle=7892ms`
against the 6000ms ratchet while samples 1-4 were 633-1809ms. The backend served
the request in ~0.5s (`POST /api/agents` arrived 23:37:53.691, Cerebras done
54.192, ASSISTANT INSERT 54.262, page fetched it 54.538, test DELETE 54.676), so
the ~7s elapsed before the browser's POST reached the backend. The backend log
has no lines at all from 23:37:39.97 to 23:37:52.955 (the page's 10s
`GET /api/agents` poll due ~49.97 never arrived), then ~50 buffered
`POST /api/dev/log` requests landed at 53.68 and normally fast routes took
99-213ms: the same host-overload stall, this time inside a latency sample.
Adaptive worker sizing cannot help here because the ratchet already runs on one
worker; the run was re-measured in the final deploy pass.

## Diagnosis

1. Chip derivation and backend hydration were correct: the persisted set was
   complete and the final count was 0.
2. The failure came from wall-clock time spent inside one probe. The renderer
   stopped servicing tasks for about 34s right after the reload boot.
3. The app's own JS was not the cause. A solo profile of the same reload showed
   a longest task of 224ms and hydration at 1.06s. With Chrome CPU throttled 20x,
   the slowest probe was 4.7s and hydration took 7.7s. The stall was a hard stop
   followed by an instant full-speed resume, which points to a process-level
   stall caused by host overload. At diagnosis time the 15-minute load average
   was 80–89 on 14 cores, and swap was 15.9 of 17.4 GB used. Whether CPU
   starvation or page-in caused the stall was not captured (observability gap:
   the runner records no host metrics).
4. Owned causes:
   - (a) The after-reload check used a client-side `expect.poll(() =>
     locator.count())`. Its timeout charges a probe that never returns. A scratch
     test that froze the renderer for 10s showed the difference:
     `expect.poll(…, {timeout: 3000})` failed at 3.0s with the incident string,
     while `expect(locator).toHaveCount(1, {timeout: 3000})` passed at 10.0s.
     The reason is that Playwright 1.63's server-side expect makes a one-shot,
     non-abortable first check (`noAbort`).
   - (b) The 0-chip check was also vacuously true before hydration.
   - (c) The local semantic gate launches a fixed four Chromium workers
     regardless of host headroom. This is the same weakness, with no admission
     control, recorded in the 2026-07-13 host-load case.

Repro (unmodified spec, real stack): `python3 scripts/semantic-renderer-stall.py
--spec browser-chip-count --agent-goal "browser chip count invariant"
--arm-after-tool-messages 7 --trigger-path '/ancestors' --delay-s 0 --stall-s 34`
with `CONDUCTOR_PORT/LOCAL_DB_PORT/BACKEND_PORT/FRONTEND_PORT` set. It
SIGSTOPs only its own run's renderers at the post-reload boot. On the pre-fix
spec it fails identically at :168. On the fixed spec the same command passes
(2/2 runs: 59.9s and 1.1m).

## Solution

- `browser-chip-count.spec.ts`: after the reload, the spec waits on the
  web-first `expect(browser-agent-chip).toHaveCount(3)` hydration gate, then
  asserts the settled 0-chip invariant. The per-wait budget
  `CHIP_SETTLE_TIMEOUT_MS` stays at 30s. This removes the vacuous pass, and the
  injected stall no longer produces a false red. A scratch run that dropped the
  terminal messages from hydration confirmed the gate fails with "persisted
  browser terminal cards never hydrated".
- `tests-e2e/helpers.ts` `trackPageProbe`: an `expectChipCount` failure now says
  `RENDERER UNRESPONSIVE: page probe #N still pending …` instead of reporting a
  bare wrong count.
- Runner capacity sizing is staged as `.context/semantic-host-capacity.patch`
  and not yet applied, because a live deploy lane was executing the runner.
  - `run-semantic-tests.sh` (local mode only) derives effective workers as
    min(requested, ⌊cpus − load1⌋), drops to 1 when free memory is below 20%,
    has a floor of 1, logs its inputs, and never waits.
  - `scripts/tests/semantic-deploy-gate.test.sh`, which already runs in
    `run-deploy-structural-gates.py`, cements this behavior.
- No timeout was raised and no retry was added. This is a harness-only change,
  so it has no 10k-agent runtime impact.

## Human feedback

None recorded. The coordinating agent relayed these task constraints: no timeout
increases, no retries-to-green, and no in-place edit of the live
`run-semantic-tests.sh`.

## Reusable lesson

When a Playwright assertion times out with one probe in flight for the whole
budget and the page emitted nothing in that window, treat it as a host-load
renderer stall: gate on hydrated state with web-first assertions and size
workers to measured host headroom instead of raising the poll budget.
