---
id: 2026-04-24-role-alternation-false-positive-aborts-benchmarks
date: 2026-04-24
title: Context validator flagged the legitimate think-before-acting pattern as dual-write corruption
surface: agents
component: context-validator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents context_validator `_check_role_alternation` — treats text-only ASSISTANT followed by tool-calling ASSISTANT as a role-alternation violation"
symptoms:
  - benchmarks abort immediately at the start of the run
  - role_alternation dual-write corruption flagged on a clean conversation
  - two consecutive ASSISTANT messages reported as a violation
tags:
  - context-validator
  - benchmarks
  - false-positive
  - role-alternation
  - agents
sources:
  - PR #553
repro: agents/tests/blackbox/context_validator.blackbox.py
status: fixed
---

## Problem

Smoke benchmarks aborted immediately. `_check_role_alternation` reported a
dual-write corruption violation on conversations that were in fact well-formed:
the agent emitted a text-only ASSISTANT message ("think before acting") and then
a tool-calling ASSISTANT message, which the validator read as two consecutive
ASSISTANT turns produced by a duplicate write.

## Diagnosis

The validator encoded a stricter contract than the agent loop actually honors.
The loop legitimately produces text-only ASSISTANT → tool-calling ASSISTANT as a
single logical turn, so strict role alternation was never an invariant of the
system being validated. The check therefore converted a normal trajectory into a
hard abort before any benchmark work ran.

The first attempted remedy was worse than the bug: `context_gates` suppression
was added to all 5 smoke benchmark tasks, which hid Andy's real user context to
make the tests pass — treating the failing benchmark as the thing to silence
rather than the validator as the thing to fix.

## Solution

Reverted `context_gates` suppression from all 5 smoke tasks, restoring the real
user context those benchmarks are supposed to exercise. Fixed the validator to
exempt the text-only-then-tools pattern while still flagging genuine dual writes
(tools-then-text-only remains flagged). Cemented with 5 blackbox tests in
`agents/tests/blackbox/context_validator.blackbox.py` covering every exemption
case: clean conversation, dual-write flagged, text-only-then-tools exempt,
tools-then-text-only flagged, two consecutive text-only assistants exempt.
Agents blackbox went to 79/79 at 80% coverage.

## Human feedback

The user explicitly rejected the `context_gates` suppression approach: hiding
Andy's real user context in the benchmark tasks to make the tests pass was not
an acceptable fix, and the PR reverted it in favor of fixing the validator.

## Reusable lesson

When a validator fires on a benchmark, prove the invariant it encodes is one the
runtime actually holds before touching the benchmark definition — suppressing
task context to go green is reward hacking, not a fix.
