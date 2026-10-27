---
id: 2026-10-27-kernel-custody-post-binding-timeout-gap
date: 2026-10-27
title: Kernel custody owner timed out after binding without its next await evidence
surface: back-end
component: browser-session-resume-custody-fixture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Unknown await after Kernel BrowserSession binding update and before the unchanged ten-second fixture owner deadline
symptoms:
  - "Crashed: Error: fixture timeout"
  - "browser-session-resume-custody.cases.ts:226:20"
  - "Kernel browser creation completed"
tags:
  - browser-custody
  - kernel
  - native-timeout
  - evidence-gap
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - plan:.context/deploy-fresh-20261027/backend-batch5.log
  - plan:.context/deploy-fresh-20261027/rca-custody-timeout-batch5/REPORT.md
repro: Native focused Kernel/incompatible case passes; no causal original red reproduced
status: open
---

## Problem

The native backend domain failed its ordinary Kernel incompatible-resume case at the existing ten-second child deadline. Parent V8 loop count27 maps all18 Browser Use cases plus Kernel's ninth ordinary incompatible case. The expected-owner-timeout branch had run only for the prior Browser Use control; this is an unexpected timeout.

## Diagnosis

The real held-create and contender STARTED observations passed. Kernel creation completed after4321ms and the owner updated its BrowserSession binding at03:39:51.553Z before the deadline. Its subsequent await is absent from retained evidence: killed owner V8, fork timer start, HTTP phases and module phases were not preserved. The remaining native path includes an old-session DELETE and dynamic Playwright evaluation, among other reads.

A healthy native focused replay passes and does not identify a repair. Two controlled12s stalls both reproduce the same unchanged ten-second failure: one in real Playwright evaluation, another in old-session DELETE. The diagnostic distinguishes their phases. These controls prove why the original last SQL line cannot uniquely locate the stalled operation; neither establishes the original cause. Earlier two-create and unhandled-owner-promise cases remain repaired and do not explain this post-binding evidence gap.

## Solution

No source repair. A scratch per-command observer retains provider/scenario, child/timer identity, fake HTTP phases, worker request phases and real module resolution/evaluation. Its hash-checking wrapper clears all fault and selection flags before the next intended canonical backend command. All49 original assertion ASTs, ten-second timer, twelve-second expected fault and retry calls are preserved. The diagnostic adds overhead and is not timing-neutral acceptance proof.

Native compatibility controls cover eight ordinary and two existing expected-timeout cases across both providers, preserving fresh-sequential negative behavior. All exact-owned rows were zero, all36 observed processes absent after native cleanup. The prepared full-backend wrapper has not been run by the author; parent owns activation and fresh full acceptance. OPEN until an actual failure captures the next await.

## Human feedback

None recorded for this failure. Repository guidance requires preserving acceptance and distinguishing an unresolved cause from a passing replay.

## Reusable lesson

Retain per-await phase and child identity before timeout cleanup rather than assigning a last-observed SQL operation as the stalled boundary.


## Related batch6 observation

The next full run failed a different ordinary Kernel fresh-concurrent scenario. Its enabled phase capture identifies real Playwright module evaluation after a completed old-session DELETE. The separate CJS/ESM fixture-seam case records that causal repair. This does not prove the older incompatible scenario waited at the same operation, so this historical case remains open.
