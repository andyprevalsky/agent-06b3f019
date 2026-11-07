---
id: 2026-11-06-semantic-deploy-fixture-orphaned-sleep30-masked-by-load
date: 2026-11-06
title: semantic-deploy fixture orphaned its fake run.sh's `sleep 30`, failing the structural gate on an idle host
surface: infra
component: scripts/tests/semantic-deploy-gate.test.sh
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/semantic-deploy-gate.test.sh cleanup_bench_fixtures() signalled only the `bash run.sh` wrapper PID, never the wrapper's `sleep 30` child
symptoms:
  - "worker exit and test results disagree"
  - deploy-command-structural receipt lingering_group true while the worker result says PASS and "All 91 deploy structural gates passed."
  - output.log.process.json orphaned_children true with term_sent of length 1 and kill_sent empty
  - a `sleep 30` process still alive when run-deploy-structural-gates.py exits
  - deploy cycle phase triage with a retained cleanup owner after a fully passing gate
tags:
  - deploy
  - structural-gate
  - fixture-teardown
  - lingering-group
  - staged-deploy-cycle
sources:
  - PR #1721
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. The PR #1721 deploy's `deploy-command-structural` gate could not
reach PASS in its staged cycle. Its idle-box full sweep ended with the worker reporting
`status PASS, native_exit 0, 418s, "All 91 deploy structural gates passed."`, yet the
coordinator recorded the occurrence as `UNVERIFIED`, incomplete, with
`reason: worker exit and test results disagree` and `lingering_group: true`. The supervisor
receipt showed `quiescent: true`, `orphaned_children: true`, `term_sent` of length 1 (one
adopted child still alive when the runner exited, ended by TERM, no SIGKILL) and
`remaining: []`. The cycle then refused `reexecute` because a lingering group is a retained
cleanup owner, and the only local cleanup proof (`structural_cleanup`) accepts failed
(exit 1) runs only, not a passing one.

The files involved are identical on `origin/main` and the PR branch (`git diff
origin/main..HEAD` is empty for them), so the PR did not introduce it.

## Diagnosis

Instrumented reproduction (subreaper wrapper that snapshots adopted children at runner
exit), idle host, frozen source `c90745e89`:

- Full structural sweep 1: exit 0, 533 s, 0 survivors.
- Full structural sweep 2: exit 0, 413 s, 1 survivor: `sleep 30`.
- `scripts/tests/semantic-deploy-gate.test.sh` alone, 3 of 3 runs: exit 0 with a
  `sleep 30` alive at exit (started about 9 s into a 14 s run).

Why sweep 1 hid it: `sleep 30` dies by itself after 30 s, so a survivor can only be alive
at exit if it was started in the last 30 s of the sweep. In sweep 1 the final suite was
`deploy-pipeline` (194 s, ran alone for the last ~125 s), so the leaked sleeper died long
before the runner exited. After sweep 1 the runner reorders suites by recorded duration,
and in sweep 2 (and the cycle's focused run) the tail is a burst of short suites
including `semantic-deploy`, so the sleeper is alive at exit. Earlier deploys passed
because they ran the gate concurrently with other gates, where load keeps a long suite
last. An idle host exposed a leak that has always existed.

Mechanism: the fixture runs `bash "$bench_repo/scripts/run.sh" &` where that script is
`sleep 30`, records `$!` (the bash wrapper), and its EXIT trap kills only that PID. The
`sleep` child is orphaned and adopted by the supervisor. Making the script `exec sleep 30`
is not an option: `live_isolated_benchmark_runs` identifies the stack by `run.sh` in the
PID's command line, so the process identity is what the test exercises.

Step 5a: the deeper owned cause is that nothing attributes a leak to its suite. A leaked
stand-in is only seen at the end of the whole sweep, only if it is still alive then, and is
charged to the aggregate gate. The 2026-11-05 case (`run-process-cleanup`, `sleep 60`) is
the same class with a different fixture; its fix repaired that one fixture and left the
detection gap. A per-suite process-group leak check in `run-deploy-structural-gates.py`
would catch every sibling, but it would turn any suite with a legitimate detached helper
into a failure across 106 suites and was not validated here, so it is recorded as a
follow-up rather than shipped in this PR.

## Solution

`cleanup_bench_fixtures()` now ends each fixture's children first (`pkill -P`), then the
fixture, then reaps it (`wait`). The test also records the fake run.sh's sleeper PID and,
after the last assertion, calls the cleanup and fails if that child is still alive.

Proof:

- Old cleanup plus the new assertion: `FAIL: fixture cleanup left the fake run.sh child
  running`, exit 1.
- New cleanup, same assertion: "All semantic deploy gate checks passed.", exit 0, no
  survivor at exit, 5 consecutive runs under the subreaper probe.

10k-agent behavior: none; this is a test fixture, not a runtime path.

Follow-up (not done): per-suite process-group leak detection in the structural runner; and
`reconcile` has no proof kind for a passing run flagged lingering, so any future leak of
this shape dead-ends a cycle until the gate is re-initialised.

## Human feedback

None recorded.

## Reusable lesson

When a gate reports a lingering process after every test passed, reproduce each suite alone under a subreaper before rerunning, because a leaked short-lived stand-in is invisible whenever a long suite finishes last.
