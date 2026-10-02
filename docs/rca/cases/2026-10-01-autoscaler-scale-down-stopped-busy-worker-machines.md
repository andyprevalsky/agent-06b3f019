---
id: 2026-10-01-autoscaler-scale-down-stopped-busy-worker-machines
date: 2026-10-01
title: Worker scale-down stopped Fly machines by list position, killing in-flight activities as heartbeat timeouts
surface: infra
component: worker-autoscaler
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/worker.py leader autoscaler scale-down, which picked the first N started peers to stop without checking whether they were running activities
symptoms:
  - activity Heartbeat timeout
  - browser activity dies about 10 minutes after a cutover with no error in its own logs
  - Fly machine stopped while running a 30m browser activity
tags:
  - autoscaler
  - fly
  - heartbeat-timeout
  - deploy
  - worker-shutdown
sources:
  - agent 3efa7cae-8051-4efd-9c49-d09f65b6e22e
  - commit 20cbae530
  - PR #1354
repro: agents/tests/blackbox/worker.blackbox.py
status: fixed
---

## Problem

On agent 3efa7cae a browser activity with a 30-minute budget failed with an
activity heartbeat timeout about 10 minutes after a deploy cutover, with no
exception from the activity itself.

## Diagnosis

Two scale-down paths chose machines to stop by position, not by load:

- The leader autoscaler in `agents/worker.py` stopped the first N started peers
  in the Fly machine list.
- The same-surface deploy script stopped machines past the minimum count by
  position.

Fly `stop` sends SIGTERM to the worker. The worker stops polling, waits out its
5-minute shutdown grace, and then calls `os._exit`. Anything still running, such
as a browser task with 20 minutes left, dies mid-step. Temporal can only observe
the death as a heartbeat timeout. The deepest owned cause is that scale-down had
no notion of busy capacity: it treated every started machine as interchangeable.

## Solution

Scale-down now scrapes each candidate's `activity_slots_used` from its health
endpoint and stops only idle peers. An unreadable count is treated as busy. The
deploy script leaves excess same-generation machines to the idle-aware
autoscaler instead of stopping them itself. Cemented in
`agents/tests/blackbox/worker.blackbox.py`.

Activities still running when a machine does drain (rolling deploy) are handled
by the step-boundary drain yield in
`2026-10-01-deploy-restarted-in-flight-browser-and-code-agents-from-scratch`.

10k agents: one health scrape per candidate machine per scale-down decision,
O(machines), never O(agents).

Residual: the scrape-then-stop sequence is not atomic. An activity scheduled onto
a machine between the scrape and the stop is still SIGTERMed. It then falls into
the drain-yield path rather than dying, unless it outlives the 5-minute grace.
A cordon-then-drain-then-stop protocol would close this gap.

## Human feedback

The user reported it as "heartbeat timeout", one of three browser failures on
agent 3efa7cae.

## Reusable lesson

A heartbeat timeout with a log stream that just stops means the process died;
look for who stopped the machine before looking at the activity's code.
