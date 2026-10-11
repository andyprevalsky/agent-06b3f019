---
id: 2026-10-10-campaign-cancel-fixture-child-exited-143-when-term-reached-its-sleep-first
date: 2026-10-10
title: The campaign-cancel fixture's cooperative child exited 143 under load because the group TERM reached its sleep before the shell and errexit ended the shell first
surface: harness
component: descend-command-gate
classification: test-bug
problem_class: other
first_bad_boundary: "scripts/tests/descend-command.test.sh fake run-bench `waiting` branch: `set -euo pipefail` with a bare `sleep 0.1` in the wait loop, signalled through os.killpg"
symptoms:
  - "FAIL: test_campaign_cancel_marks_active_and_queued_jobs"
  - "AssertionError: 143 != 0"
  - "failed deploy structural gates: descend-command"
tags:
  - deploy-gate
  - descend-command
  - run-bench-campaign
  - process-group-signal
  - errexit
  - load-sensitive
sources:
  - PR #1447
repro: scripts/tests/descend-command.test.sh
status: fixed
---

## Problem

During the PR #1447 deploy, the structural-gate run that started at `2026-10-10T23:33:26Z` (log `deploy-command-structural-20261010-233326-18823.log`) failed once:

```
FAIL: test_campaign_cancel_marks_active_and_queued_jobs (__main__.CampaignLifecycleTests...)
  File "<stdin>", line 85, in test_campaign_cancel_marks_active_and_queued_jobs
AssertionError: 143 != 0
```

Line 85 is `self.assertEqual(summary["jobs"][1]["controller_exit_code"], 0)`. The run at `23:47:20Z` on the same source passed. Six deploy lanes were running at once on the host.

## Diagnosis

Critical path: test sends TERM to `run-bench-campaign.py` → the campaign calls `os.killpg(child, SIGTERM)` (`scripts/run-bench-campaign.py:213`) → the fake `run-bench` child is expected to run `trap 'exit 0' TERM` and exit 0 → the campaign records that exit code.

First bad boundary: the fixture child, not the campaign. The child's wait loop was `while :; do sleep 0.1; done` under `set -euo pipefail`. `killpg` posts TERM to each member of the group in turn. When the `sleep` receives it first and the shell is scheduled before its own TERM is posted, the shell sees a loop-body command fail with 143, has no pending trap, and errexit ends it with 143. The campaign then faithfully reports 143.

Local repro of that ordering, made deterministic by signalling only the `sleep` (bash 5.3.15, the fixture's script verbatim apart from the ready path):

```
buggy: shell died when only its sleep was signalled; exit = 143
fixed: shell survived its sleep being signalled; exit after its own TERM = 0
```

Problem class: a fixture that assumes a process-group signal reaches the shell before its foreground child. No taxonomy bucket fits (`other`).

Archive search: `controller_exit_code`, `test_campaign_cancel_marks`, `errexit trap`, `killpg sleep`. No prior case.

## Solution

The fixture's loop is now `while :; do sleep 0.1 || true; done`: a signalled `sleep` no longer ends the shell, which then exits 0 from its own TERM trap as the test intends. Production code is unchanged; the assertion is unchanged.

Post-fix, `bash scripts/tests/descend-command.test.sh` passed three consecutive runs.

Not done: the other `while :; do sleep N; done` fixtures under `scripts/tests/` and `agents/benchmarks/` were not changed. None asserts a zero exit after a group TERM under errexit, and none has failed.

10k-agent: test fixture only; no runtime path.

## Human feedback

None recorded.

## Reusable lesson

A shell fixture that must exit cleanly from a TERM trap cannot run a bare foreground command under errexit when the signal is sent to its process group; the child can die first and take the shell with it.
