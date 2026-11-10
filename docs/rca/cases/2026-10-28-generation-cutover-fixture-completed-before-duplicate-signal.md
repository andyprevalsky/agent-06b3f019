---
id: 2026-10-28-generation-cutover-fixture-completed-before-duplicate-signal
date: 2026-10-28
title: Generation cutover fixture completed before its second real signal acknowledgement
surface: agents
component: generation-cutover-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the successor fixture completed after the first handoff signal before the second signal RPC was acknowledged
symptoms:
  - Completed workflow
  - idle_park_zero_pointer_reads_then_signal_handoff
  - second GENERATION_HANDOFF_SIGNAL RPC fails
tags:
  - temporal
  - generation-cutover
  - fixture
  - signal
  - lifecycle
sources:
  - commit 940d216341279dd23fda00003b3d774c576c3de4
  - commit 4c118e0de38c3a0c3f3b1dd93d3b30d89d099608
  - plan: .context/deploy-fresh-20261027/main-sync7/generation-cutover-fixture-proposal/
  - plan: .context/deploy-fresh-20261027/rca-workflow-terminal-batch12/recurrence-940d/fixture-peer-review.json
repro: agents/tests/blackbox/generation_cutover.blackbox.py
status: open
---

## Problem

The native agents gate on 940d216 failed
idle_park_zero_pointer_reads_then_signal_handoff. The retained traceback points
to line 246, the second real handle.signal(GENERATION_HANDOFF_SIGNAL, NEW_QUEUE),
with temporalio.service.RPCError: Completed workflow. The first signal at line
244 succeeded. The original log is
.context/test-runs/agents-coverage-20261028-081510-2781896/generation-cutover.log.

This is distinct from the foreground browser-cutover 60-second timeout and
does not identify that other workflow's first-bad boundary.

## Diagnosis

Path: fixture waits 19 simulated minutes with zero queue-pointer reads -> first
real signal RPC -> pointer activity -> continue-as-new successor -> immediate
fixture completion -> second real signal RPC. The test required two signal
acknowledgements and exactly one pointer read, but did not retain its successor
until the second acknowledgement. InToolCutoverWorkflow returns immediately
when the handed-off successor starts.

Archive literal search used Completed workflow|Logical browser restore
requires validated transport; the incidental hit concerned completed workflow
tasks, not this RPC error. The behavioral search used
duplicate.*signal|signal.*terminal|in.place.*rotation|same.native.*response.
The October 5 deploy terminal-fixture case and September 12 worker fixture
ownership case were relatives, not recurrences. Their Solution and Human
feedback favor explicit fixture ownership and retention of original failures.
The July 29 browser-context structural-boundary case was also read.

A private driver exercised the full seven-case fixture, actual local Temporal
servers and unchanged production helpers. After the first real acknowledgement
it waited for the pointer activity to return or block. If it returned, it
observed the actual terminal result before allowing the second signal. It
fabricated neither acknowledgements nor results. This selected the failing
legal interleaving; the original scheduler was not recorded.

Both variants used this identical command from agents:

    /home/boxes/rose/agents/venv/bin/python -m coverage run --rcfile=/home/boxes/rose/agents/pyproject.toml /home/boxes/rose/.context/deploy-fresh-20261027/main-sync7/generation-cutover-fixture-proposal/driver.py

Original exit 1 in 8.094 seconds: six siblings passed and the owning case failed
with Completed workflow. Candidate exit 0 in 7.731 seconds: all seven passed.
The original trace is first acknowledgement, pointer return/read 1, actual
terminal result, second send, RPC failure. Candidate trace is first
acknowledgement, pointer blocked/read 0, second send and acknowledgement,
pointer release/read 1, actual completion.

Frozen patch SHA-256:
0c7a0a32e3fc966c370b5ec21e8e7cc031c6dcfd94b3d2e4a9054f33f4775884.
Unchanged driver SHA-256:
9fe39207af8ad1c4c6ea9fd98ef5323110ae8fb99b8f967270fdaaeb532f2782.
The packet's native-manifest.json binds both source variants, commands, logs
and traces. An initial nonexistent-coverage-config invocation failed before
fixture imports or service startup and is excluded from causal evidence.

## Solution

Only this scenario installs an asyncio.Event in the existing pointer mock.
The activity awaits it before counting/returning. The two original real signal
RPCs execute first. An added assertion checks zero pointer reads while both
acknowledgements are owned; finally releases and removes the event. All 18
original assertion ASTs are preserved, with 19 after the change. The one-read,
handoff, elapsed-time and preceding 19-minute assertions remain unchanged,
along with the 15-second activity bound and production workflow helpers.

Independent review reconstructed the exact candidate and found no blocking
change. The root applied the correction in 4c118e0. The assertion lives in the
existing generation-cutover blackbox run by agents coverage.

Native cleanup at 08:38:56.948725 UTC records 14 Temporal child identities,
zero matching-birth survivors, empty driver child trees and completed fixture
shutdowns. No browser, database or live-provider resources were created. The
original failed gate and controlled red are retained.

This draft stays open pending fresh combined owning acceptance on 4c118e0.
It claims neither the unrecorded original scheduling details nor closure of
the separate 60-second workflow failure, production or Mac acceptance.

## Human feedback

The coordinator required every original assertion and clock to remain,
forbade swallowing Completed workflow or retrying to pass, and required both
real server acknowledgements before release. The coordinator owns canonical
edits and full validation; this case was drafted privately during monitoring.

## Reusable lesson

A duplicate-signal fixture must keep its recipient alive until both native
acknowledgements exist. Own that lifetime explicitly instead of relying on
the speed of a sequential test caller.
