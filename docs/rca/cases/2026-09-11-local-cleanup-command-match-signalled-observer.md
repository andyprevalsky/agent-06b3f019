---
id: 2026-09-11-local-cleanup-command-match-signalled-observer
date: 2026-09-11
title: Local benchmark cleanup adopted observers through command text and connected sockets
surface: harness
component: benchmarks-local-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/local.py cleanup candidate discovery treated a run-ID substring or connected TCP endpoint as service ownership
symptoms:
  - scratch benchmark launcher exited 143 after services had stopped
  - cleanup killed an unrelated observer that mentioned the run ID
  - connected client was misclassified as the service listener
tags:
  - local-benchmark
  - ownership
  - cleanup
  - process
sources:
  - PR #1299
  - agent 7d0687bf-a5b9-4639-9501-56d06948362d
repro: agents/tests/blackbox/benchmark.blackbox.py
status: open
---

## Problem

The unchanged local `polar-odysseys-4246dec196c9` task returned ordinary FAILED
at the authorized 300-second backstop. Its browser recording and durable FE/LLM
evidence were verified, and independent checks confirmed its browser session,
processes, database container and volume absent. After diagnostics, the scratch
launcher exited 143 without persisting its child's exit status. Its filename
contained `proof14-fixed-local`, the run ID, and its cwd was the same worktree.
The pre-fix baseline's observer had run outside that baseline worktree and
survived. This case concerns cleanup selection; it does not claim to fix the
shopping task's capability timeout or reproduce the separate cloud archive ERROR.

## Diagnosis

The path was `local.main finally → stop_services →
_kill_scoped_processes_by_run_id → os.kill`. The first bad boundary was candidate
discovery: a global `ps` scan selected any command containing the run ID. The
cwd check proved only a shared worktree, and excluding the current PID still
left observers and callers eligible. The unrelated command was already wrongly
classified before any signal was sent.

A permanent actual-process blackbox test reproduced this boundary. In a private
same-cwd fixture, an observer mentioned the run ID only as an argument while a
separate service PID was recorded in the manifest. Before removal of the scan,
`test_local_cleanup_does_not_signal_processes_that_only_mention_run_id` failed
with `cleanup killed an unrelated observer that mentioned the run ID`. Afterward,
the unchanged test preserved the observer and reaped the manifest-owned service
in 1.076 seconds. Both exact fixture processes were joined in every outcome.
Initial scratch import-path and macOS `/var` alias setup failures are preserved
and excluded from causal evidence; the valid fixture resolves its physical cwd.

Independent adversarial review found a sibling at the second discovery path.
`lsof -ti tcp:<port>` selected both a listener and clients connected to it. An
actual same-cwd TCP fixture confirmed that cleanup killed the unrelated client
as well as the service, with no run-ID argument involved. The permanent
`test_local_cleanup_port_candidates_exclude_connected_clients` exercises real
listener/client subprocesses, the actual lsof query and cleanup. It failed on
`connected client was misclassified as the service listener`; the unchanged test
passes when the query selects listening sockets only. It also requires the
owned listener to exit and the connected client to survive. Readiness is explicit
and every exact fixture process is joined.

Archive searches were `isolated local cleanup run_id launcher killed` and
`command substring observer process cleanup ancestor`. The July 13 fleet
argument-pattern and July 29 kill-services ancestor cases are relatives, not
this same first-bad function. Their guards did not cover the local Python runner.
The deepest proven class is adopting a process from an association with a run,
rather than the intended service identity. No signal-sender audit was retained
for the live observer, so the isolated causal reproduction supports this
mechanism without claiming a captured live sender PID.

## Solution

Delete the redundant global argument scan and restrict the existing port query
to `-sTCP:LISTEN`. Keep manifest services/descendants, isolated-stack scope,
worktree checks and existing teardown bounds. Deletion removes the ambiguity
for launchers, report collectors and other observers without adding a list of
special protected command names. Listener filtering removes the connected-client
sibling at the discovery boundary.

At 10,000 agents this removes the host-wide argv scan from each local teardown;
the remaining work is limited to that stack's manifest process descendants and
fixed service-port set. It adds no service, thread, connection or shared lock.
This change does not solve stale manifest PID reuse or establish ownership of a
replacement listener; those existing limits are not presented as fixed here.

The owning regressions are registered in the benchmark blackbox runner, which
agents coverage and `/deploy` execute. Scratch commands are
`agents/venv/bin/python .context/setup/run-local-cleanup-observer-repro.py` and
`agents/venv/bin/python .context/setup/run-local-cleanup-port-repro.py`; before
and after logs are under the proof14 evidence-finalization RCA artifacts.
The full final-source blackbox/coverage loop and live deploy validation remain
pending, so the case stays open.

## Human feedback

The user asked to finish without repeated permission requests, keep normal
120-minute backstops, and use a temporary five-minute limit for this validation.
They require ten sequential ten-task cloud slices with no infrastructure outcomes.
No benchmark definition, timeout, evaluator or acceptance criterion changed here.

## Reusable lesson

Never infer teardown ownership from a run-ID mention or a connected socket; select the actual owned service before signalling it.
