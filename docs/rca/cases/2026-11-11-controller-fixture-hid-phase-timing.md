---
id: 2026-11-11-controller-fixture-hid-phase-timing
date: 2026-11-11
title: Controller fixture redirected its only phase boundary evidence away from native output
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run_controller redirects the child streams without publishing invocation timing or status to the outer native log
symptoms:
  - controller invocation lacks bounded START/END timing events
  - cloudbench-multi-workstream.test.sh 0/5 1200s
  - PASS: scenario 15
  - UNVERIFIED
tags:
  - cloudbench
  - fixture
  - observability
  - timeout
sources:
  - PR #1881
  - commit bc541819b2c9e3477a6c4cd3af421e3e1bcd931d
  - task GitHub Actions 42940590508
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: open
---

## Problem

The assigned whole-unit failure remains open. On source bc541819b2c9e3477a6c4cd3af421e3e1bcd931d, occurrence e902209a228c4fecbe48b212be676946 and token865a53528e004e69a5dd273e375cd643, the original32-unit stability inventory returned31PASS and1FAIL. The complete multi-workstream shell unit's first loaded attempt timed out at1200 seconds with native exit null and0/5. Its aggregate is UNVERIFIED/complete=false/cleanup_complete=true. The original log SHAfe61cb7469497652160c8a1fa1a01353585c2449f214209dbcc010364d98a40b ends at scenario15 PASS. Scenario16 is next in source; the log does not prove it started or stalled there. The separate normal controller PASS in1416.444 seconds is not loaded-five credit or a lower bound.

## Diagnosis

The actual run_controller function sends both child streams to a private per-controller log and exposes only its eventual exit status to the shell. The outer native output lacks invocation start/end timestamps. select_affected_tests._run_once kills the owned process group on its1200-second timeout and returns the outer log, so no cleanup-trap logger can reliably recover the unfinished phase. Previous differently sourced private traces and isolated scenario passes cannot identify the current cumulative critical path.

The added owning control extracts and executes the actual function with a local child script. The final unchanged assertion fails original code with `controller invocation lacks bounded START/END timing events`, exit1. It checks ordinary0/1/143 exits, exact child arguments and selected environment, unchanged child stdout/stderr destination, two simultaneous children, and actual owned process-group TERM/KILL. It also checks rejected unbounded/private labels and failed logger writes. This proves the observation gap and status preservation; it does not reproduce or repair the full runtime overrun.

Two archive searches covered multi-workstream1200/fixture timeout and readiness/capture/redundant fixture symptoms. Related prerequisite, fake-provider, PID and ready-marker cases concern the same assigned symptom but do not supply full native acceptance. Earlier writable-clock proposals remain rejected. No clock, retry, task, timeout, load or assertion change follows from this case.

## Solution

External candidate: emit bounded START and END metadata using Bash builtins on the existing native stderr around the unchanged child invocation. The line contains only a validated synthetic log basename, actual Bash PID, observed epoch timestamps, and the original exit status. No paths, arguments, environment values, payload, new log destination, signal handler, clock seam or artifact schema are introduced. Invalid metadata and logger failure cannot create success. TERM/KILL retains an honest unmatched START rather than inventing completion. Concurrent calls retain separate process identities.

The identical owning control fails original source and passes five unchanged candidate repetitions; the complete existing registered cleanup suite passes. The unchanged full f8 sleep ratchet and embedded-Python sleep AST comparison are recorded in the private handoff. A preliminary logger-failure test incorrectly closed a descriptor inside a command-scoped redirection, which Bash then restored; its failed assertion is retained as a test-harness correction, not a product failure. A first external ratchet export had a symlinked baseline and skipped its history comparison; the corrected byte-identical local baseline is checked against the actual f8 revision without a skipped comparison.

No canonical source or native gate was changed by this worker. This patch repairs only missing phase evidence. The next actual authorized whole-unit run must retain1200 seconds, five repetitions, eight load slots, every case and assertion. The original timeout remains assigned, UNKNOWN and blocking until its cause and original acceptance are proved. Golden reference: the existing child invocation, its redirections and statuses are the code-only reference; no agent behavior, benchmark definition or user-facing contract is changed.

## Human feedback

The parent required a minimal external observation-only change in run_controller, its existing registered owning regression and an OPEN case. It prohibited full/scenario/native reruns, new clock/cache/skip behavior and source/cycle/provider changes. The parent specifically required bounded synthetic labels, original exit statuses, concurrent identity, logger-failure handling and honest interrupted phases.

## Reusable lesson

Publish bounded invocation metadata to the existing native stream before entering a long child whose private logs may be unavailable after forced termination, and keep observability proof separate from runtime acceptance.
