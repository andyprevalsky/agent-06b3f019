---
id: 2026-09-08-central-hub-port-select-swallows-free-probe
date: 2026-09-08
title: Central hub port selection treated a free port as a TCP probe failure because bash $? after if is 0
surface: infra
component: cloudbench-hub-port
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_select_central_hub_port — probe_rc=$? after `if cloudbench_tcp_listener_present; then`
symptoms:
  - FATAL: central hub TCP probe failed on port 42000 (rc=0)
  - refusing fail-open port selection
  - benchmark run is not visible in the central hub
  - test_central_hub_runs_in_own_session_after_launcher_exit
tags:
  - cloudbench
  - hub
  - bash
  - port-selection
sources:
  - PR #1293
  - commit db686562235f25d54e65206796a32995d15e9f61
repro: scripts/tests/cloudbench-env.test.sh
status: fixed
---

## Problem

`/deploy` Step 4cb failed on
`test_central_hub_runs_in_own_session_after_launcher_exit` with
`FATAL: central hub TCP probe failed on port 42000 (rc=0)`.

Local repro of that exact pytest failed the same way on this revision
(exit 1, stderr `rc=0` on a bind-checked free port). Port 42000 had no
listener (`connect_ex` 111).

## Diagnosis

Critical path: `start_central_hub` → `cloudbench_select_central_hub_port`
→ `cloudbench_tcp_listener_present` (0=busy, 1=free, 3=error).

The selector did `if cloudbench_tcp_listener_present; then ...; fi` then
`probe_rc=$?`. In bash, `$?` after a completed `if` is 0 when the
condition was false. A free port (probe exit 1) therefore became
`probe_rc=0`, which is not 1, so the function fail-closed as a probe
error instead of allocating the port.

Archive search (`central hub TCP probe failed port 42000`): relative of
2026-07-19 colliding hub reuse — same symptom, different midpoint (this
is `$?` after `if`, not CONDUCTOR_PORT collision). Novel.

## Solution

Capture `probe_rc=$?` immediately after the probe, then branch on 0/1/other.
Cemented in `scripts/tests/cloudbench-env.test.sh` (free preferred port
must be selected) and the original pytest.

10k-agent: one extra integer capture per hub boot, no per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

Capture `$?` immediately after the command that produced it — never after an
`if`/`while`/`until` whose condition already consumed the status.
