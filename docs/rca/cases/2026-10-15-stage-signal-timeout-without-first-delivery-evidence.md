---
id: 2026-10-15-stage-signal-timeout-without-first-delivery-evidence
date: 2026-10-15
title: Stage termination observer failed without original first-signal evidence
surface: harness
component: deploy-stage-signal-cleanup
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Registered stage communicate observer exceeded ten seconds after TERM; delivery causality unproven
symptoms:
  - test_timing_wrappers_terminate_child_groups_and_record_signal
  - stage_process.communicate(timeout=10)
  - subprocess.TimeoutExpired
tags:
  - deploy-stage
  - signal-cleanup
  - missing-delivery-evidence
sources:
  - commit 10716a5b101d7a8c05ef0dfb3b2bccdd63bec5b7
  - plan:.context/test-runs/agents-coverage-20261015-183122-3027251/predeploy-metrics.log
  - plan:.context/deploy-runs/merged-10716a5b-verification/predeploy-signal-orphan-before-cleanup.json
  - plan:.context/deploy-runs/merged-10716a5b-verification/predeploy-signal-open-rca.json
repro: none-recorded
status: open
---

## Problem

At merged source `10716a5b101d7a8c05ef0dfb3b2bccdd63bec5b7`, normal agents coverage finished with 109 passing domains and one failure, exiting 1 before coverage combine, fastcache, unit tests, or threshold evaluation. Structural, seed, and controller lanes were not started. The owning command from repository root was:

```bash
source agents/venv/bin/activate
cd agents
bash ../scripts/run-deploy-stage agents-coverage-blackbox -- env AGENTS_COVERAGE_CONCURRENCY=6 bash scripts/run-coverage.sh
```

The retained `predeploy-metrics.log` traceback identifies `test_timing_wrappers_terminate_child_groups_and_record_signal` at line 289, `stage_process.communicate(timeout=10)`, raising `subprocess.TimeoutExpired`. The command under observation was `bash /home/boxes/rose/scripts/run-deploy-stage slow-stage -- bash -c "printf '%s\n' $$ > '/tmp/tmp_72gp05a/stage-child.pid'; while :; do sleep 1; done"`. Eight other domain checks passed.

## Diagnosis

The registered fixture waits for a nonempty child PID file, calls `stage_process.terminate()`, then observes completion for ten seconds. The wrapper execs Python; `_run_logged` installs signal handlers before starting the child in a new session. Its handler records the signal, forwards it with `os.killpg`, and schedules the existing 60-second cleanup grace. A signal during the Popen assignment window is already remembered and forwarded after assignment. Because the child's PID file is written only after handler installation, generic pre-handler delivery is not supported by this fixture's readiness evidence.

The original snapshot retained Python supervisor 3027875 (birth `linux:6af9c450-c2c8-4647-a911-8ab19a296bbf:4896622`) and direct child bash 3027880 (birth ending `:4896627`, process group 3027880), both alive after the observer failed. It did not retain first-TERM handler execution, delivery order, original signal mask/disposition, or pipe-holder state. Therefore the failure cannot be attributed to delivery, deferred handling, or output-pipe lifetime. The fixture's lack of `finally` cleanup around the failed observer explains retained owned processes, but does not explain the initial failure to terminate.

The unchanged focused owner with the coverage bootstrap passed all nine checks in 5.5 seconds:

```bash
source agents/venv/bin/activate
cd agents
COVERAGE_FILE=/home/boxes/rose/.context/deploy-runs/merged-10716a5b-verification/focused-coverage bash ../scripts/run-deploy-stage predeploy-metrics-focused-rca -- coverage run --parallel-mode scripts/run_blackbox_tests.py predeploy-metrics
```

The log is `.context/deploy-runs/merged-10716a5b-verification/logs/predeploy-metrics-focused-rca-20261015-183558-3147167.log`. A private observer subsequently invoked the same registered signal-cleanup assertions unchanged:

```bash
source agents/venv/bin/activate
LANTERN_SIGNAL_TRACE=/tmp/lantern-signal-observer/order.jsonl PYTHONPATH=/tmp/lantern-signal-observer python /tmp/lantern-signal-observer/run-exact.py > /tmp/lantern-signal-observer/result.log 2>&1
```

That observed pass captured parent/child identity, signal state, handler entry, and group forwarding approximately one millisecond after the first TERM. The observer can affect timing; this is not a causal failing reproducer or recovered evidence from the original failure. Independent read-only review agreed that the original causal gap remains. A separate direct-child-exited/descendant-held-pipe edge in cleanup is not attributable here because the original direct child was alive. Archive searches found no exact prior case; related timeout evidence-preservation guidance supplied no causal diagnosis.

## Solution

No runtime, fixture, observer deadline, or cleanup grace was changed. The case remains open, without a load, flake, fix, or waiver classification. The original full gate remains failed despite the focused pass. A future recurrence needs first-signal handler/send order, parent/child birth and group identity, native signal state, and output-pipe ownership at the failing boundary.

After recording exact ownership, a birth-validated TERM to owned supervisor 3027875 invoked its normal cleanup; both recorded processes were confirmed absent at 18:34:53 UTC. Remaining healthy coverage owners joined at 18:35:46 UTC. No foreign process was signaled. The original orphan snapshot and open report preserve the cleanup provenance.

## Human feedback

None recorded.

## Reusable lesson

Retain first-signal delivery, handler order, process identity, and pipe ownership from the failing invocation before diagnosing a termination observer timeout.

## Recurrence 2026-11-09 (PR #1901 deploy, Blacksmith runner)

`agents-coverage-blackbox` on head 2705eba5fb8b, run
https://github.com/Rose-Ai-Labs/rose/actions/runs/42673221026 (blacksmith-8vcpu),
had 130/131 domains passing. `predeploy-metrics` failed `signal_cleanup`:
`stage_process.communicate(timeout=10)` raised `TimeoutExpired` after TERM to
`scripts/run-deploy-stage slow-stage`. The same domain passed 3/3 on the
devbox at the same head. The changed files (`scripts/run_deploy_pipeline.py`,
`scripts/deploy_prod.py`) are not on this path. No first-signal delivery
evidence was captured, so the observability gap above remains open; the
classification is unchanged.
