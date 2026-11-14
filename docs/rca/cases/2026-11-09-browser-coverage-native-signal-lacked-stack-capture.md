---
id: 2026-11-09-browser-coverage-native-signal-lacked-stack-capture
date: 2026-11-09
title: Browser coverage process exited on SIGSEGV without a native stack for attribution
surface: agents
component: spawn-browser-agent-v3-blackbox
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: the coverage subprocess exited with native code -11 during the resume-store size test; the native crash site and causality remain unproven
symptoms:
  - "spawn-browser-agent-v3"
  - "exit_code: -11"
  - "Browser resume archive unavailable; keeping snapshot inline"
  - "agents-coverage-blackbox/agents-coverage-blackbox"
tags:
  - browser
  - coverage
  - native-signal
  - segfault
sources:
  - PR #1864
  - commit 9db9d8435fc5e46934ff3add0353ac8dd03a7145
  - plan:.context/agentcard-e2e/deploy-gate-rca.json
repro: PYTHONFAULTHANDLER=1 BLACKBOX_TEST_CAPTURE_OUTBOUND=1 venv/bin/coverage run --parallel-mode scripts/run_blackbox_tests.py spawn-browser-agent-v3
status: open
---

## Problem

The native agents coverage results recorded `spawn-browser-agent-v3` false,
duration 137.731 seconds, and exit code -11. Its log ended after the inline
fallback warning inside the registered resume-store size test, with no failed
assertion, Python traceback, native stack or core in the returned artifacts.
Occurrence `0d78f559002e475a9fbfa5cecd35a2a5` is aggregate UNVERIFIED, not PASS.
The aggregate separately failed production-payment-admission, owned by the
deployment coordinator; one domain's result cannot waive that constituent.

## Diagnosis

Negative subprocess status -11 denotes SIGSEGV, rather than an assertion
failure, suite timeout or provider error. The runner preserved the signal
code but the process had no faulthandler stack. The last warning does not
establish that its code caused the crash. The same registered resume-store
test passed five times under coverage locally. The entire unchanged domain
also passed twice with faulthandler enabled in 239.9 and 241.1 seconds on this devbox.
Native lifecycle and concurrency differences remain unmeasured; no introduced
or non-introduced attribution is asserted without a reproduced crash site.

The memory-termination journal was absent on this devbox; it says nothing
about the remote runner and does not prove an OOM. The September 11 worker
native-callback case is related but its shutdown/native-stack proof is absent
here, so its cause is not borrowed. No actual root agent ran these mock cases;
a Rose agent bug report is not applicable.

## Solution

No speculative runtime, retry, timeout or assertion change was applied.
Collect an unchanged owning-domain execution with Python faulthandler and
native core capture on the affected runner, retaining its original signal
and every constituent result. The local successful replay is supporting
diagnostic evidence only; it does not erase the failed remote gate or prove
the native defect fixed. Both bounded local diagnostic trials and their exact
logs are recorded in the private source-bound receipt. Golden reference: not
applicable (no approval-gated hunk).

## Human feedback

The delegated task prohibited criteria or timeout changes, blanket waivers,
new benchmarks and financial calls, while requiring exact native evidence.

## Reusable lesson

Capture the native stack before attributing a signal-terminated test to its last log line.
