---
id: 2026-09-04-pipefail-turned-grep-match-into-list-services-failure
date: 2026-09-04
title: Pipefail turned an early grep match into a list-services assertion failure
surface: harness
component: kill-services-structural-test
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/tests/kill-services.test.sh list_output assertions
symptoms:
  - list-services did not show worktree listener PID while the printed output contains that PID
  - deploy-command-structural fails kill-services only under concurrent gate load
  - grep finds the first service row and the assertion still exits nonzero
tags:
  - bash
  - pipefail
  - sigpipe
  - kill-services
  - structural-test
sources:
  - PR #1246
repro: scripts/tests/kill-services.test.sh
status: fixed
---

## Problem

The deploy structural lane reported `list-services did not show worktree
listener PID 15218`, then printed a table whose first service row visibly began
with PID 15218. The same suite passed when immediately rerun alone, so the
assertion contradicted its captured evidence and was scheduling-sensitive.

## Diagnosis

Archive searches for `kill-services list-services listener PID shown but
assertion missing`, `worktree process discovery cwd proc lsof race`, `pipefail
grep -q echo SIGPIPE assertion output contains match`, and `grep q closes pipe
early pipeline false negative` found related cleanup timing cases but no exact
shell-assertion recurrence.

The test enables `set -euo pipefail` and evaluated captured output with
`echo "$list_output" | grep -q "$worker_pid"`. When the matching PID appeared
in an early row, `grep -q` was allowed to close its input immediately. If the
producer still had another row to write, it received SIGPIPE. `pipefail` then
made the whole pipeline nonzero even though grep had returned success. Parallel
coverage made multiple service rows and the adverse scheduling more likely.

A deterministic shell probe with a multi-line matching payload recorded
`PIPESTATUS=141 0`: producer failure followed by successful grep. The first bad
boundary was the test assertion, not service discovery.

## Solution

Every `producer | grep -q` assertion in the structural test now gives grep a
here-string. There is no concurrent producer to receive SIGPIPE, so the
pipeline cannot invert a successful match. The test also rejects future
early-exit grep pipelines in its own source. The full deploy structural runner
remains the permanent concurrent regression path.

## Human feedback

None recorded.

## Reusable lesson

Under pipefail, feed early-exit grep assertions from a file or here-string instead of a live producer whose SIGPIPE can invert the result.
