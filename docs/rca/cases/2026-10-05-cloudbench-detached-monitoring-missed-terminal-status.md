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
  - detached fleet completed (exit=1) but its printed controller exit marker was absent
tags:
  - cloudbench
  - monitoring
  - lifecycle
sources:
  - fleet run 20261005-220635-19583
  - fleet run 20261005-224256-949
  - commit ca2cb3163e1b2f0dce448959bd96e6f3b70a774e
  - fleet run 20261007-155532-35109
  - commit 5051c0594905da7f1170fd3d20c9d17cca160500
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

## Recurrence: --wait consumed the printed terminal receipt

Control 6's ordinary fifty-task CLI launcher printed
`detached-20261007-155531-34548.status`, then reported
`detached fleet completed (exit=1)`. The original launcher and controller were
natively absent, `_batch/lifecycle.json` preserved controller exit 1, and the
printed marker was absent. The original closed controller log's retained hash
is `fa3f847bb7c77ffab881826bae2ec6f7d9343681d4b0daa75d23a67b737e62ad`.
Its host ENOSPC errors remain original evidence; this marker finding does not
attribute them to inherited pipes or repair the rejected fleet's task outcomes.

Archive searches were `No space left on device detached controller status` and
`missing detached exit marker launcher wait pipe status file`. This is a
recurrence of the monitoring contract above. The September 10 inherited-pipe
case is a relative, and the October 5 waited-fixture case documented the older
intentional consumed-rendezvous behavior. That behavior conflicted with the
documented promise that the printed monitor handle remains available with `--wait`.
The earlier regression exercised only immediate-return detach, so it missed the
waiter's different terminal cleanup path.

Critical path: supported `scripts/run-bench` launch → atomic detached status
wrapper → native tracked-group drain → waiter reads exit status → waiter deletes
status and ownership rendezvous → independent monitor loses the terminal handle.
What: normal waited completion lost its printed terminal receipt. Where:
`scripts/lib/cloudbench-env.sh::cloudbench_wait_tracked_detached`, after reading
the status. Why: cleanup treated durable exit evidence as ephemeral ownership
state. Proof: the supported CLI's existing offline exit-after-snapshot-claim hook
returned its real exit 7 while the permanent monitor test found zero status
receipts on the original helper. The deepest owned problem remains the
observability contract: waiting changed the lifetime of the printed evidence.
The same gap affected both successful and failed controller exits.

The unchanged owning command was
`python -m pytest -q 'agents/benchmarks/cloudbench_monitor_test.py::test_fleet_monitor_detached_launch_retains_actual_controller_exit[wait]'`,
using the existing Python 3.11.9 agents environment with modern Bash on PATH.
It failed in 11.17 seconds with `detached launch lost its actual exit status`
on helper SHA256 `b4bd1f3355f97a49ddce476975f8fe2e26f7635cdd659fd83708f66740ea5ef0`.
The same test bytes passed in 1.44 seconds after retaining the terminal status.
Private RED/GREEN outputs and both source/test hashes are retained under
`.context/cli-marker/` in the isolated RCA checkout.

Delete the status file from the waiter's removal list. The exact owner file and
temporary files still retire after the existing native group checks. Both normal
CLI launch modes now share one durable terminal receipt; no new receipt, polling
service, cleanup fallback or acceptance condition is added. The monitor test also
requires exit 7 with cleanup still unknown, so controller completion cannot claim
resource release. The existing Linux multi-workstream waited case now requires
its exact retained exit 0 and absent owner while preserving native resource and
older-receipt checks. These controls remain in the existing compact
`benchmark-live-results.test.py` and controller deploy gates.
The complete monitor file passed all nine controls in 3.01 seconds. The Linux
controller fixture is part of the combined deployment verification, not a new
LIVE fleet. Archive validation passed with all 812 cases retained.

At 10,000 agents, the change removes one unlink per waited controller and retains
one tiny existing receipt per launch. It adds no scan, channel, shared lock or
agent-wide work. This fixes only the CLI evidence lifetime. Control 6 stays
rejected, earns zero campaign credit, and retains its original receipts; fresh
ordinary fifty-task LIVE outcomes and exact cleanup still require independent
proof. The user required supported CLI execution, broad outcome checks, exact
owner cleanup and compact regression coverage.

## Recurrence: child controller failure stayed hidden behind teardown occupancy

Original Control9 (`20261007-185005-80376`, source `9a55d781`) had an IMAX
child-supervisor exit125 by 19:22:11 UTC. Its original collector had reported
missing guest cleanup acknowledgement, but the ordinary monitor continued to
report teardown with no warning and `next_action=observe_again`. The full run
later failed its one-hour gate. That result remains rejected; this operator
repair does not repair the underlying worker cleanup or certify resource release.

Archive searches were `fleet monitor hides abnormal child controller exit` and
`teardown child finished missing cleanup acknowledgement`. This is a recurrence
of the monitor's terminal-observation contract. The September29 stack-receipt
case is a relative with a separate cleanup first-bad boundary. Here the path is
child supervisor's atomic exit marker → monitor's existence-only stage read →
operator receives teardown occupancy without the available abnormal exit. The
earlier controls covered the parent terminal handle and ordinary task FAIL, but
not a terminal child while healthy siblings continued.

Read the existing tiny child marker as well as its existence. Exits0/1 remain
ordinary task outcomes; another exit is disclosed as a task-controller warning
with instructions to inspect it while healthy siblings continue. This changes
no grading, occupancy, timing, cancellation, ownership or acceptance criterion.
No private log, transcript or request content is printed. Final parent/lifecycle
inspection still takes priority over an intermediate warning.

The existing deploy-owned `cloudbench_monitor_test.py` now exercises exits0/1
and the original cleanup/cancellation exits125/143 through `scripts/run-bench`.
The identical test bytes failed on `d03b9eb8c` because both abnormal exits still
returned `observe_again`; after the repair, the four cases passed in0.28s.
The complete existing module passed13 controls in3.96s, and independent review
passed the same13 in4.05s. A read-only comparison on the original C9 directory
confirmed unchanged outcomes, occupancy and lifecycle/controller fields while
disclosing all three abnormal children. Tests already run in the compact normal
deploy wrapper's `fleet_monitor` selection; there is no new paid or long gate.
Source/test/log hash bindings and the independent receipt are private under
`.context/monitor-rca.private/`. No LIVE50 or production-deployment credit follows
from this warning-only repair.
