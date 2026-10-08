---
id: 2026-10-07-zero-grace-teardown-judged-sigkill-at-delivery
date: 2026-10-07
title: Zero-grace tree teardown judged a SIGKILLed process alive before the kernel finished its exit
surface: harness
component: cloudbench-env
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_terminate_tree_and_wait reused the TERM grace as its post-SIGKILL verification window
symptoms:
  - "Process <pid> (proc-start:...) survived SIGKILL verification"
  - "FAILED benchmarks/cloudbench_dependency_sync_test.py::test_sealed_primary_retirement_requires_join_and_returned_permits_before_reset[KILL-/bin/bash]"
tags:
  - process-teardown
  - sigkill
  - host-load
  - flaky-test
  - deploy-step-4s
sources:
  - PR #1417
repro: scripts/tests/cloudbench-env.test.sh
status: fixed
---

## Problem

The `benchmark-live-results` deploy structural gate failed one parameter of
`test_sealed_primary_retirement_requires_join_and_returned_permits_before_reset`:
`[KILL-/bin/bash]` exited 42 with `Process ... survived SIGKILL verification`.
The gate ran beside the backend, frontend, and agents coverage lanes on a
four-core host with a load average near 13.

## Diagnosis

The KILL variant calls `cloudbench_terminate_tree_and_wait 0 <pid>` on a
fixture that ignores TERM. The helper used `timeout_seconds` for both the TERM
grace and the later SIGKILL verification. With zero seconds, the verification
loop read each captured birth once, immediately after `kill -KILL`. Its
deadline had already passed, so a process that was still running at that
instant was reported as a survivor. The kernel completes SIGKILL
asynchronously. On a busy host the target often has not been scheduled
through its exit when the first read happens.

The failure reproduced locally under 12 CPU spinners in 11 of 15 runs, and in
none of 10 unloaded runs. Production callers pass 30 seconds, so the
zero-grace window affected only callers that asked for immediate escalation.

## Solution

Post-SIGKILL verification now waits at least five seconds, or the caller's
grace if that is longer. It still requires positive evidence for every
captured birth: absent, zombie, or replaced. A genuine survivor or an unknown
identity still fails closed once that bound expires. `cloudbench-env.test.sh`
stubs the identity primitives to model a birth that is still running on the
first post-KILL read and gone on the next. With zero grace, the old helper
fails that case and the fixed helper re-observes and passes. The original
test then passed 15 of 15 stressed runs across all four parameters.

## Human feedback

None recorded.

## Reusable lesson

A delivered signal is not a completed effect; verify an asynchronous kernel transition over a bounded window, even when the caller asked for no grace before escalation.
