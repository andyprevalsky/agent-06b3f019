---
id: 2026-07-14-editing-a-shell-script-under-a-live-bash-interpreter
date: 2026-07-14
title: Editing `run-bench-fleet` mid-run killed the live controller — bash reads scripts lazily
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: run-bench-fleet executed directly from the mutable git checkout while an edit shifted bytes under the running interpreter
symptoms:
  - "syntax error near unexpected token 'fi'"
  - live 28-box fleet controller dies at t+573s with no failure in the benchmarks themselves
tags:
  - cloudbench
  - bash
  - lazy-script-read
  - self-modification
  - fleet
sources:
  - commit 486563a7a
  - memory:project_daily_suite_concurrent_iteration
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Iteration 7 had already provisioned, launched and autoscaled all 28 boxes in
~9.5 minutes when the controller died at t+573s with
`syntax error near unexpected token 'fi'`. No benchmark had failed; the run was
lost to the controller's own script.

## Diagnosis

`run-bench-fleet` was being edited while the controller was executing from that
exact file. Bash reads a script lazily — it re-reads from a byte offset as
execution proceeds — so an edit that shifts bytes causes the interpreter to
resume mid-token and abort with a syntax error. The deeper owned cause is that
the long-lived controller executed directly from the mutable git checkout, so
any concurrent edit (including a well-intentioned fix for the very run in
flight) was a live-code mutation.

## Solution

Snapshot-exec: the fleet now re-execs from an immutable per-invocation copy of
the fleet script, the cloud script, and the env library _before_ parsing args or
taking locks; children resolve the binary through `RUN_BENCH_CLOUD_BIN`, and
`CLOUDBENCH_FLEET_ROOT` preserves repo-relative paths; cleanup reaps the snapshot
directory (commit 486563a7a). Cemented by
`test_controller_execs_from_a_script_snapshot`. Corollary that now holds by
construction: edits to these scripts will never be picked up by a live run.

## Human feedback

None recorded.

## Reusable lesson

Long-lived shell controllers must re-exec from an immutable per-invocation
snapshot of their own scripts — never edit a script that a live bash process is
still reading.
