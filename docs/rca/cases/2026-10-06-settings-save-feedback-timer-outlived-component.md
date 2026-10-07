---
id: 2026-10-06-settings-save-feedback-timer-outlived-component
date: 2026-10-06
title: Settings success callbacks survived component and test-environment retirement
surface: front-end
component: settings-save-feedback
classification: our-bug
problem_class: other
first_bad_boundary: Settings save hooks allocated success-reset timers outside a React effect owner
symptoms:
  - ReferenceError window is not defined
  - useSaveCustomization.ts:31:24
  - All frontend tests passed but Vitest reported one uncaught exception
  - expected 1 to be +0
tags:
  - react-effects
  - settings
  - timer-ownership
  - component-unmount
sources:
  - PR #1424
  - commit 7872fa3d78d7ba38d2556d5b354fe0fc0400ee95
repro: front-end/src/tests/blackbox/settings.blackbox.tsx
status: fixed
---

## Problem

The ordinary frontend coverage gate on the recorded commit completed all 149
files and 2,634 tests (three skipped), then exited nonzero for an uncaught
`ReferenceError: window is not defined`. Its stack identified the success-reset
callback in `useSaveCustomization`. The original private output is preserved;
no request bodies or test trajectories are included here.

## Diagnosis

The path was successful settings PATCH, saved indicator, an independently
allocated three-second callback, component unmount, jsdom retirement, then a
React state update from the still-live callback. The save API and assertions
had succeeded. The first bad boundary was allocating a callback without a
component lifecycle owner. `useSavePersonalInfo` used the same pattern.

Two archive searches used `ReferenceError window is not defined
useSaveCustomization` and `settings success timer callback after unmount
teardown`. Broad matches did not identify this owning cause. This is a novel
case of UI callback ownership, rather than evidence that the benchmark image
or runtime failed. The `other` bucket describes a UI resource lifecycle defect.

The owning blackbox renders the actual hook, completes its normal PATCH through
the existing MSW server, observes saved feedback, unmounts, and checks that no
callback remains. With the original hook it failed with `expected 1 to be +0`
in 20.111 seconds. The unchanged test and command passed in 13.846 seconds
after the fix. These are verification durations, not production speedup claims.

## Solution

Each settings save hook derives its reset callback from the committed saved
state in a React effect. React retires that timer when saved state changes or
the component unmounts. An API completion after unmount cannot allocate the
effect. The three-second visible feedback interval and save request remain
unchanged. No lifecycle flags, fallback, broader test guard, prompt, evaluator,
benchmark task, or production timeout was added.

The owning command, run from `front-end` with Node 22.13.0, was unchanged:

```sh
node node_modules/vitest/vitest.mjs run src/tests/blackbox/settings.blackbox.tsx -t 'retires the customization success callback' --maxWorkers=1
```

The complete existing Settings blackbox subsequently passed 25/25 in 17.153
seconds with no unhandled error. The existing Vitest blackbox include and
ordinary frontend coverage deploy gate discover this additional case; no new
live gate or framework is required. Full deploy qualification remains a
separate ongoing requirement. At larger scale each component owns at most one
reset callback and retains none after retirement.

## Human feedback

The user requested concise verification, permanent quick deploy tests, and
stage completion with no lingering resources. No additional approval boundary
was introduced for this UI callback repair.

## Reusable lesson

Own delayed UI callbacks in the React effect lifecycle of the state they display.
