---
id: 2026-10-30-it28-recovery-native-read-bypassed-deadline
date: 2026-10-30
title: Exact-owner recovery bypassed the native read deadline
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Omitted timeout in machine_status_exact_read and machine_config_exact_read selected unbounded FLY calls
symptoms:
  - "Exact recovery remained in flyctl machine status for more than 406 seconds"
  - "An interrupted partial not-found response could be classified as native absence"
tags:
  - r123
  - it28
  - native-read
  - recovery
sources:
  - commit d0663f361a1118ce6776d1ab8aaa0987dcf252a5
  - memory:owner-57100c65e07744c59a71176d7fa4810d
repro: scripts/tests/cloudbench-recovery-fd.test.py
status: open
---

## Problem

The first canonical It28 recovery ran from d066 with controller PID3347292.
Its exact readonly `flyctl machine status` child3348961 remained live for at
least406.52 seconds. A separately authorized single identity-checked TERM to
that local read ended the canonical recovery with exit1. No provider Machine
was signalled, no resource release was proved, and all twelve owners remained
retained. Original benchmark results remain1PASS/1FAIL/18cancelled.

## Diagnosis

`fleet_recovery_reconnect_guest_shutdowns` calls `registry_machine_details`
without an explicit timeout. The status helper selected direct FLY execution
for that omitted value, bypassing the existing bounded native transport. The
configuration sibling had the same bypass. The original reason the native
client failed to complete is not established by this local process evidence.

The unchanged permanent tests fail against d066: four tests contain seven
failing subtests, including missing default deadlines and partial not-found
output misclassified after interruption. The tests exercise the actual shell
helpers and existing timeout wrapper with inert local executables. They do not
make native provider calls or recreate the unknown upstream outage.

## Solution

Both exact-read helpers use the existing `fly_with_timeout` with a30-second
default, preserving explicit shorter budgets. Invalid or zero budgets do not
dispatch. Interrupted status reads return unsafe2 before textual absence
matching; only completed native absence keeps return1. No guest ACK, release,
registry, retry, benchmark deadline or task grade is synthesized.

Independent exact-patch review f36eaac9ebc4d33d79948d97c4f473c40856087569057e0267e3c44f8c89c560
was GROUNDED. On the composed checkout the existing registered command
`agents/venv/bin/python scripts/tests/cloudbench-recovery-fd.test.py` passes
all6 controls in3.528s; Bash syntax and pinned Python compilation pass. The
existing structural gate already runs this module. Actual1-second expiration
uses a public explicit test budget; production default remains30seconds.
Original native connectivity and successful owner recovery remain OPEN.

Primary implementations reviewed: Codex exec expiration distinguishes timeout
and cancellation; OpenClaw runExec supplies a default bounded invocation;
Hermes resolves omitted timeout to configured policy. Their numeric defaults
and background-promotion behavior are not copied. Rose reuses its existing
native timeout and process-ownership implementation.

## Human feedback

The user prioritizes native failures, progress0 and schema/validator flow
without excluding other failures. The standing task requires verified results
and preserved original evidence.

## Reusable lesson

An exact native read must remain bounded when its caller omits a budget;
interrupted text is not completed evidence of absence.
