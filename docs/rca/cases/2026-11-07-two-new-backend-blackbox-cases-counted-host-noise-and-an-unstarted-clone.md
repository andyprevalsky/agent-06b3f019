---
id: 2026-11-07-two-new-backend-blackbox-cases-counted-host-noise-and-an-unstarted-clone
date: 2026-11-07
title: A fake GitHub counted the devbox daemon's HEAD probe, and an interrupted-clone case could interrupt a clone that had not reached git
surface: back-end
component: code-sessions
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/helpers/fake-github.ts recorded every request including the sprite-daemon's unsolicited `HEAD /` port probe; code-sessions-ws-startup.cases.ts sent SIGTERM as soon as the server reported `cloning`, before its fake git had logged the clone start
symptoms:
  - "while blocked, no call reaches GitHub: 2 !== 1" in blackbox:github-rate-limit (extra request `HEAD /`, unauthenticated)
  - "the interrupted clone is repeated, not resumed from debris: 1 !== 2" in blackbox:code-sessions
tags:
  - load-flake
  - sprite-daemon-probe
  - fake-github
sources:
  - PR #1744
repro: github-rate-limit failed 3 of 28 runs under 24 busy loops on the unchanged test and recorded the extra `HEAD /` request (0 of 16 after the fix, same load); the unit case in github-rate-limit-fixtures.test.ts sends `HEAD /` to the fake. The clone case was not reproduced in 10 loaded runs.
status: mitigated
---

## Problem

Both cases are new on this branch and failed in the third staged backend gate under heavy host load, then passed alone. Gate: INTRODUCED (new tests).

## Diagnosis

On boxes.dev the host daemon sends `HEAD /` to every new local listener about a second after it opens (known from earlier deploys). The fake GitHub logged it, so the exact request count the case asserts moved by one whenever the probe landed inside the window; the captured request log of a failing run shows it. For the clone case the server reports `cloning` before it spawns git, so under load the interrupt can land first and the restart is then the first clone, which fits the observed count of 1; this mechanism is plausible but was not reproduced, hence mitigated.

## Solution

The fake answers `HEAD /` without recording it, and the clone case waits until its fake git has logged the first clone before interrupting.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A fixture that counts requests on a real listener must count only what the system under test can send, and an interrupt must follow an observed effect, not an announced state.


## Recurrence — November 10, live-clone budget started before the listener

A subsequent full sharded coverage run passed 252/253 domains but failed the
code-sessions case `a finished clone is reused on resume, and the readiness
waits tell a dead server from a busy one`: `typed as cloning, not unreachable`,
actual `[false, down]`, expected `[false, cloning]`. The live-clone subcase
started the 400ms dead-listener budget directly after spawning Node; under
load the process had not bound yet. Production's down classification was
correct for that actual state. This is another missing fixture-precondition
barrier, not a production readiness timeout defect.

The permanent fixture now deterministically delays this server launch by
1000ms, then waits via existing `until` / `probeWsServer` until it reports
cloning before measuring the original live-clone assertion. Its clone release
file stays absent, so it cannot finish and accidentally satisfy a ready check.
The 400ms down budget, 1500ms clone budget and expected result are unchanged.
No production code, timeout, or evaluator bound was changed.

Executed the same owning-domain command before and after:
`cd back-end && ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 CONDUCTOR_WORKSPACE_NAME=ws-fixture-rca CONDUCTOR_PORT=58300 bash scripts/run-blackbox-tests.sh code-sessions`.
Before: deterministic down-versus-cloning failure, 96/97.
After: 97/97, full domain completed in 47.409s. TypeScript, ESLint and Prettier
passed. The parent reruns the full gate on the frozen fixture. This new proof
does not retrospectively close the original interrupted-clone observability
gap recorded above or relabel the earlier mitigation.

10k impact: test fixture only; no production request, query or channel changes.
No new human feedback was recorded for this test-only recurrence.


## Final combined validation — November 10

Source: commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265. Full frontend coverage passed 324 files,
4,732 tests passed and one skipped; line coverage 89.69%, branch coverage
81.87%. Full backend failed-first sharded coverage passed all 253 selected
blackbox domains and all 391 unit files (including the separately scheduled
browser-performance probe), with line/statement coverage 90.26%, functions
93.13% and branches 82.95%. Configured thresholds passed; backend teardown
checks also passed. The coverage runner intentionally excludes the separate
live credential-health domain. No production rollout or live account probe
is implied by these local validation results.

Commands: `cd front-end && npm run test:coverage`;
`cd back-end && bash scripts/run-coverage-sharded.sh --failed-first 2 && bash ../scripts/tests/blackbox-backend-teardown.test.sh`.
