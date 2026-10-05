---
id: 2026-09-28-fly-command-polling-delayed-native-completion
date: 2026-09-28
title: Fleet provider command polling delayed already completed native operations
surface: infra
component: cloudbench-fleet-command-supervision
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: fly_with_timeout slept one second after its foreground provider command had already completed
symptoms:
  - concurrent worker readiness publication and scale-down must preserve surviving capacity
  - FATAL autoscaled worker never crossed scale-down boundary
  - sequential worker file stages advanced approximately one second per completed command
tags:
  - cloudbench
  - autoscaler
  - worker-readiness
  - native-process-lifetime
  - command-timeout
sources:
  - PR #1299
  - commit fb30bc4c874e0c49ffee33d54f6079a909ef1b56
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The full r4 controller gate failed scenario 2i after 931.75 seconds, before any
paid proof launch. The fake primary reported that an autoscaled worker never
crossed the scale-down boundary within the existing 30-second fixture phase.
The controller had correctly preserved the surviving worker in both allocation
and ready ledgers. Its autoscaler had no fatal record and later published
completed-after-child. The failure was not missing surviving capacity.

The retained run was 20260928-002749-23240. Barrier release occurred at
00:28:03.704697 UTC. The two diagnostic workers published their queue-ready markers at
00:28:18.616753 and 00:28:22.448780. Scale-down cancellation began at
00:28:32.184833, while capture and destruction finished around
00:28:34.58–34.98. The primary had already stamped its error by
00:28:34.292833. Final teardown later overwrote the shared scale-down marker;
that marker's final modification time cannot establish the first destruction.

## Diagnosis

The path was barrier release → worker provisioning and staged file transfers →
actual worker readiness → lower desired capacity → complete worker evidence
capture → exact worker destruction. Individual staged operations repeatedly
advanced by approximately one second despite immediate fake-provider replies.
The owning fly_with_timeout function launched its command, checked liveness,
and unconditionally slept one second before it could observe completion. The
same delay applied to every completed command, including sequential uploads.
This accumulated work consumed the fixture's unchanged phase budget.

Archive searches used "concurrent worker readiness publication scale-down
preserve surviving capacity" and "autoscaler ready worker race capacity missing
readiness". The post-child worker-ledger contention and missing-terminal
scheduler-window cases from 2026-08-03 are relatives. The raw-runtime-evidence
case from 2026-09-27 explains the real capture work now exercised, but does not
own command-completion polling. No exact prior cause was found.

The actual function was extracted into three owning controls: immediate success,
nonzero exit, and explicit shell exit. Each must preserve complete output and
its native status without a polling interval. On the unchanged runtime all
three failed the 0.5-second completion check at approximately 1.03 seconds.
The exact original scenario 2i body also reproduced its original failure in
93.77 seconds, with a verified empty terminal process audit. Its body SHA256
was 34a8305eaca2fefc84ac3c17ae3bb3d6faf5aff00ff5bee026a9c13ee993ba23.

## Solution

Replace periodic liveness polling with a modern-Bash timed FIFO read. The sole
command-owning shell retains the writer through native exec and EXIT handlers;
EOF therefore includes its complete foreground lifetime. The parent preserves
native output and exit status, retains the existing deadline and timeout
TERM/grace/KILL behavior, and joins the child. Invalid budgets and read failures
cannot become successful unbounded waits. Zero budgets reject immediately.
Before timeout signals, the child must still be a running job owned by this
shell; an unsupported detached writer cannot authorize signalling a retired
root PID. This does not claim a general repair for arbitrary detached process
trees: production FLY runs a foreground flyctl command.

There is one blocking wait and a constant number of descriptors per active
provider command. There is no polling-rate increase, independent watchdog,
shared lock or shared hot path at 10,000-task scale. Worker counts, evidence
validation, benchmark behavior, normal 7,200-second backstop, proof 300-second
backstop, and the fixture's 30/240-second limits stay unchanged.

Twenty-two owning cases cover immediate exits, hung commands, setup failure,
combined output, descriptor closure, caller traps, exit-handler and exec
lifetimes, invalid/zero budgets, read errors and retained descendant writers.
The existing three clone retry/deadline controls remain in the additive
canonical selection. Their isolated environments now preserve PATH so Mac
uses the modern Bash already required by CLAUDE.md; unchanged originals were
also executed on Linux. The benchmark blackbox callable and /deploy selector
include the new controls; scripts/test.sh already runs their complete module.

Private artifacts under .context/acceptance/proof21-concurrent-readiness-rca/
retain the original gate, exact guest files, timeline, unchanged focused
reproduction, rejected early-notification candidate, independent falsification,
final owning controls and subsequent focused results. The first candidate's
80.71-second scenario 2i success is historical causal evidence only: review
caught that its notification preceded EXIT-handler completion. The final EOF candidate passed the unchanged 2i/2j/2k bodies in 129.05 seconds,
with native exit 0 and a verified empty terminal process audit. Its 22 owning
controls plus the three unchanged Linux clone controls passed. The strengthened
permanent selection passed all 25 cases on Mac in 29.60 seconds; injected
descriptor and temporary-file leaks independently failed the precise resource
assertions. Remaining unchanged scenarios 3–16 and source promotion are recorded
separately. The full final
controller gate and actual 10×10 campaign remain required; this case grants no
live benchmark credit.

## Human feedback

The user requires infrastructure fixes while preserving benchmark tasks,
models, evaluators, workload and limits. Keep the normal two-hour backstop and
use five minutes for the diagnostic campaign; do not weaken fixture assertions
or enlarge phase deadlines to manufacture success.

## Reusable lesson

Observe native command completion directly while keeping the deadline active through the entire owned process lifetime.
