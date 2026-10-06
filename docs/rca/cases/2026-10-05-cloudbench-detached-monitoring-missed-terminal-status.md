---
id: 2026-10-05-cloudbench-detached-monitoring-missed-terminal-status
date: 2026-10-05
title: Detached benchmark monitoring did not expose a consistent terminal handle
surface: infra
component: benchmark-cli-monitoring
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: default detached fleet launch omitted the atomic controller exit marker available to --wait
symptoms:
  - monitoring old capacity logs after the controller had exited
  - default detached launch lost its actual exit status
  - caller-relative monitoring paths resolved from agents instead of the caller
  - startup label remained cloning after every modern boot start was accepted
tags:
  - cloudbench
  - monitoring
  - lifecycle
sources:
  - fleet run 20261005-220635-19583
  - fleet run 20261005-224256-949
  - commit ca2cb3163e1b2f0dce448959bd96e6f3b70a774e
repro: agents/benchmarks/cloudbench_monitor_test.py
status: fixed
---

## Problem

A fifty-task launch exited before task allocation at 22:12:14 UTC, but the
operator continued reading its prior capacity logs until noticing the terminal
receipt at 22:25. The operator missed the available supervisor receipt; the CLI
printed a log tail without a complete monitoring protocol. Ordinary detached
launches also lacked the atomic exit marker already supplied by `--wait`.
The user requested continuing observation and instructions printed at launch.

## Diagnosis

Archive searches were `detached monitor stale terminal status` and `benchmark
monitoring relative path launcher cwd`. The September 9 status-proxy readiness
case and September 11 observer-ownership case are relatives; neither covers
the missing detached terminal handle or caller-relative monitor paths.

The new read-only CLI exposed task stage counts and cleanup independently. Its
independent reviewer then reproduced two integration defects: relative paths
resolved after the wrapper changed into `agents`, and default detach still had
no exit marker. The same two permanent controls failed before correction:
the relative fixture reported zero running tasks, and the actual default
detached launcher supplied no exit status. They passed unchanged afterward.
The default-detach control executes the real CLI and existing script-snapshot
claim boundary with an offline terminal child; it makes no provider calls.

Continued observation of the unchanged live fifty-task fleet found another
monitoring gap: all fifty logs contained the accepted modern boot-start marker
and every boot configuration was released, while every startup label still said
cloning. The tracker understood only legacy SSH messages. The permanent owning
replay failed with `cloning` instead of `staging` before correction, then passed
unchanged with the current producer messages. A rejected start stays staging;
the existing legacy and elapsed-time controls remain unchanged. This is related
to the archived July 16 launch transport replacement, which did not update this
observer's marker contract.

## Solution

Reuse the existing atomic status-recording wrapper for every detached launch;
`--wait` selects whether the launcher waits. Preserve caller paths when routing
the new `scripts/run-bench monitor` operation. Every launcher prints observation
cadence, private log and exact exit marker; the child prints its own actual run
directory and complete monitor command. Never publish the parent's different
run directory as the child's handle.

The monitor reads local allowlisted metrics and lifecycle files. It checks the
exit marker even when the progress card is stale, separates evaluated outcomes
from cleanup and controller exit, and reports missing observations as warnings.
It does not cancel, recover, restart or provision resources. It prints no request
bodies, logs or trajectories and introduces no new benchmark acceptance gate.

Six owning controls passed in 1.05 seconds; the existing live-results deploy
wrapper passed 25 controls in 18.62 seconds. The existing detached snapshot
handoff control passed in 11.05 seconds. Independent review reran all six controls
in 0.90 seconds and confirmed the existing tracked-session and snapshot-ownership
semantics. The compact controls remain in the always-run deploy wrapper and
benchmark blackbox domain. CLI, benchmark, descend and deploy pointers agree.
The active live fleet remains on its original frozen source; this operator
improvement does not certify its task outcomes or resource retirement.
The startup observer now recognizes the existing modern producer markers as
well as legacy ones. It changes labels only, preserving lifecycle, grading,
deadlines and runtime behavior. Its four controls join the same compact wrapper.
The first automated review also found malformed-row and lifecycle-receipt input
handling gaps. One compact owning control reproduced the failure before the fix
and passed unchanged afterward: malformed cards fall back to persisted selection,
non-string outcomes become queued, invalid selection warns, and a matching
nonterminal lifecycle receipt remains nonterminal. Seven monitor controls pass
in 1.02 seconds. The cloud timeout guidance now explicitly requires both the
guest execution environment override and the orchestration flag.
The final automated review found that foreground lifecycle completion still
suggested another observation when there was no detached exit marker. The
existing terminal-receipt control reproduced this before correction and passed
unchanged afterward. Either validated terminal signal now directs inspection
of the exact owned resources; controller completion remains a separate field.

## Human feedback

Monitor the active run throughout execution and make the CLI print instructions
for future agents. Keep quick regressions in deploy without adding a massive
verification workload. An observation timeout must not trigger an unnecessary
run reset. Genuine benchmark failure is acceptable for infrastructure proof.

## Reusable lesson

Print an exact terminal handle with every asynchronous launch and inspect it on
every observation independently of progress-card freshness.
