---
id: 2026-10-14-cleanup-fixture-certified-fork-before-worker-exec
date: 2026-10-14
title: Cleanup fixture accepted a fork before its worker cwd and argv were published
surface: infra
component: run-process-cleanup-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/run-process-cleanup.test.sh wait_for_process accepted kill -0 before child cd and exec published the cleanup discovery identity
symptoms:
  - 'FAIL: same-worktree worker with stale backend is killed: process 391694 is still alive'
  - 'run-process-cleanup: exit=1 duration=3.80s'
tags:
  - deploy
  - process-cleanup
  - fixture-readiness
  - startup-race
sources:
  - task deploy run 20261014-220120-4186766
repro: scripts/tests/run-process-cleanup.test.sh
status: fixed
---

## Problem

The second deploy structural run passed 45 of 46 suites. Its
`.context/deploy-runs/20261014-220120-4186766/logs/deploy-structural-20261014-222541-361854.log`
line 3027 reports the stale worker remaining alive. An earlier full run and an
initial standalone rerun passed. The failing suite printed no stale-worker
discovery message before its assertion, so signal-delivery latency was not the
observed boundary.

## Diagnosis

The fixture launched a subshell, then treated its immediate PID existence as
worker readiness. Before that child had executed `cd` and Python, its cwd,
`worker.py` argv, queue, and backend URL were not yet available to the ownership
filter. The production helper correctly retained an unidentifiable process.
The test began discovery too early and later blamed cleanup for not killing it.

The local reproduction delayed only fixture-child `cd` by 0.8 seconds through
`BASH_ENV`; the production cleanup helper and suite assertions were unchanged:

```bash
BASH_ENV="$PWD/.context/rca-cleanup-startup-race/delay-fixture-cd.sh" bash scripts/tests/run-process-cleanup.test.sh
```

The baseline exited 1 with the same stale-worker assertion, recorded in
`.context/rca-cleanup-startup-race/baseline.log`. The identical command passed
after fixture readiness was corrected; the final output is in
`.context/rca-cleanup-startup-race/fixed-cemented.log`.

Archive searches used `run-process-cleanup stale backend process still alive`
and `worker cleanup process terminal reaping fixture race`. This is a novel
fixture boundary, related to the October 2 logical/physical cwd case rather
than a recurrence: both cwd spellings are correct here.

## Solution

The existing fixture now waits for a ready file published by Python after exec,
retains the existing three-second startup bound, and uses exec so the recorded
PID names the fixture process. Sweep fixtures use the same handshake. A
permanent controlled child held before exec proves that a live fork cannot
certify readiness; after its gate opens, the same child publishes its marker.
All cleanup assertions and production ownership checks remain intact.

Golden reference: `openclaw/test/openclaw-launcher.e2e.test.ts:1230` publishes a
child's ready receipt and `:1253` waits for that receipt before using the child.
The fix converges on that application-owned readiness handshake. Searches of
Claude Code, Hermes, and Codex for ready-file/startup-ready shell cleanup
fixtures found no direct analog.

The standalone deterministic replay and shell syntax check pass. Root
adversarial review accepted the owning-boundary proof and permanent
blocked-child readiness control. The canonical unchanged full gate command
then passed all 46 suites:

```bash
bash scripts/run-deploy-stage deploy-structural -- python3 scripts/run-deploy-structural-gates.py
```

Its log is
`.context/deploy-runs/20261014-220120-4186766/logs/deploy-structural-20261014-224854-703590.log`;
the owning run-process-cleanup suite passed in 19.06 seconds. The exact runner
and stage PIDs exited afterward. This changes test fixture startup only and
adds no production work, polling, or shared resources at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Wait for a child-published readiness receipt before testing discovery that depends on its cwd, argv, or environment.
