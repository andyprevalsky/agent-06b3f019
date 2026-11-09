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
