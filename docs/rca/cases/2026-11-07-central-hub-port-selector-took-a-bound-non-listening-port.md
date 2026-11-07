---
id: 2026-11-07-central-hub-port-selector-took-a-bound-non-listening-port
date: 2026-11-07
title: Central benchmark hub selector treated a refused connect as a free port, so every start attempt re-picked a port another socket had bound
surface: infra
component: scripts/lib/cloudbench-env.sh cloudbench_select_central_hub_port
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/lib/cloudbench-env.sh cloudbench_select_central_hub_port — returned the preferred port whenever the TCP connect probe was refused, without checking that the hub could bind it"
symptoms:
  - "failed to bind or reuse a central benchmark hub after 20 attempts"
  - "benchmark run is not visible in the central hub; refusing to continue invisibly"
  - "OSError: [Errno 98] Address already in use"
tags:
  - cloudbench
  - hub
  - ports
  - deploy
  - load
sources:
  - PR #1749 staged deploy on 8d436372f, gate cloudbench-controller step selected-pytest (test_central_hub_runs_in_own_session_after_launcher_exit; _hub/hub.log shows 20 launches on 127.0.0.1:42000, each EADDRINUSE)
repro: scripts/tests/cloudbench-env.test.sh (central hub bound-only port contract)
status: fixed
---

## Problem

PR #1749's sweep failed `cloudbench-controller`. In its selected pytest step,
`test_central_hub_runs_in_own_session_after_launcher_exit` reported "failed to
bind or reuse a central benchmark hub after 20 attempts". The run's
`_hub/hub.log` holds 20 hub launches on 127.0.0.1:42000. Each one died with
`OSError: [Errno 98] Address already in use`. The same gate passed on an earlier
sweep of this PR, and the PR does not touch the hub or its selector.

## Diagnosis

`cloudbench_select_central_hub_port` probes the preferred port with a TCP
connect, and a refused connect counts as "free". On Linux, three occupants
refuse connections and still make the hub's bind fail, even with
`SO_REUSEADDR`:

- a loopback client using that port as its outgoing port (42000 is inside this
  host's 32768–60999 automatic port range);
- that client's 60-second TIME_WAIT;
- a socket that is bound but not listening.

Under load, one of these held 42000 after the test's probe. `start_central_hub`
then re-picked the same port on every attempt. The same defect can hit
production startup on `DASH_BASE`.

Reproduced on the unchanged test by binding its chosen port without listening,
right after the probe. The test failed with the exact gate message.

## Solution

The new `cloudbench_tcp_port_bindable` performs the hub's own bind
(127.0.0.1 with `SO_REUSEADDR`) and releases the port. It exits 1 when the
address is in use and 3 when the check itself fails. A port with no listener is
selected only if it is also bindable; a port in use is skipped like a foreign
hub, and a failed check still refuses fail-open selection. Timeouts and attempt
counts are unchanged.

The visibility test now reads the port the hub actually bound from its owner
record. The regression in `scripts/tests/cloudbench-env.test.sh` holds a
bound-but-not-listening socket on the preferred port and requires selection to
skip it. It runs in the cloudbench-controller gate's `environment` step and
fails on the old library (`cloudbench_tcp_port_bindable: command not found`,
"a bound-only socket must probe as in use"). That file passed five consecutive
runs with the fix.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A refused connect proves only that nothing is listening. Before choosing a
port, make the same bind the server will make.
