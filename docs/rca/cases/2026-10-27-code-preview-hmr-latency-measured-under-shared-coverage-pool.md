---
id: 2026-10-27-code-preview-hmr-latency-measured-under-shared-coverage-pool
date: 2026-10-27
title: Code-preview Rose-in-Rose HMR latency was measured inside the contended parallel coverage pool
surface: back-end
component: blackbox-runner
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/blackbox/run.ts ran code-preview in the parallel domain pool, so its write→DOM HMR wait competed with CPU-bound sibling domains
symptoms:
  - "page.waitForFunction: Timeout 10000ms exceeded."
  - "Rose-in-Rose HMR: an agent write to the Rose front-end reaches the preview DOM in ≤ 3 s"
  - code-preview fails only in full backend coverage
tags:
  - flaky-test
  - coverage
  - vite
  - code-preview
sources:
  - task User Scale Bug Bash lane S20 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
repro: back-end/src/tests/blackbox/code-preview.blackbox.ts
status: fixed
---

## Problem

On 2026-10-27, `code-preview` failed in 2 of 3 full backend coverage runs on the
8-core devbox, both times in subtest 11, "Rose-in-Rose HMR". The agent's file
write never reached the preview DOM within the 10 s wait, against a ≤ 3 s
target. The domain passed whenever it ran alone.

## Diagnosis

The subtest measures product latency through a real Vite dev server. The
coverage runner executes four domains at once plus V8 instrumentation, so
CPU-bound siblings starved Vite's transform and HMR push. This is the same
failure mode already documented for `browser-provider` and
`steel-injection`, which run in the runner's late exclusive set for that reason.
Re-running the same domain alone passed every time, so contention was the
variable.

## Solution

`code-preview` joins `lateExclusiveDomainNames`. It runs after the parallel pool
drains and before the cooldown-setting `codex-code`. Its ≤ 3 s target, 10 s wait
and assertions are unchanged. `coverage-script.test.ts` pins the membership.

10k-agent behaviour: test-only. There is no runtime change.

## Human feedback

None recorded.

## Reusable lesson

A blackbox case that asserts real latency belongs in the uncontended exclusive phase, not the shared parallel pool.
