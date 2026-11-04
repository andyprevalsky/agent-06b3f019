---
id: 2026-10-15-temporal-test-startup-without-child-phase-evidence
date: 2026-10-15
title: Temporal test startup failure remains open without child phase evidence
surface: harness
component: workflow-blackbox-temporal-startup
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: SDK ephemeral server readiness exceeded five seconds; causal startup phase unproven
symptoms:
  - Failed starting test server
  - ephemeral server at 127.0.0.1:41485 did not start within 5s
tags:
  - temporal
  - startup-readiness
  - missing-phase-evidence
sources:
  - commit 405b1dbcb9d87d125a81a3fabd51165341ed3f8b
  - plan:.context/test-runs/agents-coverage-20261015-012740-2392305/workflow.log
  - plan:.context/deploy-runs/review-405b1dbc-verification/coordination-handoff.json
  - plan:.context/deploy-runs/resumed-405b1dbc-verification/temporal-startup-open-rca.json
repro: none-recorded
status: open
---

## Problem

At source `405b1dbcb9d87d125a81a3fabd51165341ed3f8b`, the normal six-worker agents coverage run failed the workflow domain while starting its first shared Temporal test environment. From repository root, the owning command was:

```bash
source agents/venv/bin/activate
cd agents
bash ../scripts/run-deploy-stage agents-coverage-blackbox -- env AGENTS_COVERAGE_CONCURRENCY=6 bash scripts/run-coverage.sh
```

The original workflow log retained `ERROR: Failed starting test server: ephemeral server at 127.0.0.1:41485 did not start within 5s. Make sure another download isn't stuck and delete the temp file.` The last preceding pure assertion was `wf_fast_mode_post_message_nonblocking`. The separate, later user pause interrupted remaining coverage; it does not explain this earlier actual workflow failure.

## Diagnosis

The observed path is the normal workflow blackbox runner, `_run_all_workflow_tests()`, its first `WorkflowEnvironment.start_time_skipping()`, then SDK ephemeral-server launch/readiness. The parked-tool environment was not reached. Original child startup stderr, readiness phase, process state, and download state were not retained beyond the SDK error. No deterministic cause was established. Archive searches for the exact startup string and Temporal startup/readiness found related fixture cases, but no evidence supporting adoption of their causes here.

After explicit resume, the prior exact owned processes were absent and port 41485 had no listener. No foreign process was cleaned up and no SDK temporary file was deleted. The unchanged focused command passed both workflow environments in 46.1 seconds:

```bash
source agents/venv/bin/activate
cd agents
bash ../scripts/run-deploy-stage workflow-focused-rca -- python scripts/run_blackbox_tests.py workflow
```

Its log is `.context/deploy-runs/resumed-405b1dbc-verification/logs/workflow-focused-rca-20261015-181502-2686441.log`. Subsequent normal coverage at the same source passed 110 domains, 184 fastcache tests, 134 unit tests, and the 82% coverage result against the 80% threshold; its log is `.context/deploy-runs/resumed-405b1dbc-verification/logs/agents-coverage-blackbox-20261015-181605-2700335.log`. These observations do not recover the missing original startup phase or establish a fix.

## Solution

No runtime, fixture, startup bound, or timeout was changed. The case remains open; neither load nor a transient defect has been established. The original failure is retained independently of later passing gates. A future recurrence needs original child launch/readiness evidence before assigning a causal bucket.

During the separate user pause, a birth-validated interrupt to owned coverage supervisor 2392305 used normal cancellation cleanup. The coverage stage exited 130; recorded owned PIDs 2392086, 2392189, 2392305, 2392308, 2491151, 2493725, 2493731, 2493770, and 2493872 were confirmed absent. The coordination handoff records that interrupted remainder separately. No structural/controller lane was launched during that interruption.

## Human feedback

None recorded.

## Reusable lesson

Capture the failing ephemeral server's launch and readiness phases before attributing an SDK startup deadline failure or claiming that a later pass fixed it.

## October30 PR1634 recurrence

At source fa0310f9f6a55cd4f937f59ab4af51bd385b16fb, the normal one-worker agents coverage run failed the workflow domain at its first shared Temporal startup. The exact original error named127.0.0.1:40801 and the unchanged five-second deadline. The domain took20.55s (inner runner16.3s). Evidence is retained in .context/test-runs/agents-coverage-20261030-012155-1751030/workflow.log. The preceding pure check passed; the second parked environment was not reached.

Original child stderr, PID and readiness phase are still missing. The cached84,478,216-byte test-server ELF and dynamic dependencies were present. Earlier root-disk exhaustion is not a demonstrated cause of this startup failure; no direct write failure appears in this log. The complete investigation is .context/pr1634-workflow-startup-rca/report.md.

One small diagnostic subsequently entered the SDK context in under one second, then its extra reporting statement raised TypeError. That reporting error is separate from the original startup failure; this was not a clean workflow pass. After the existing coverage lane ended, the unchanged full owning command `venv/bin/python scripts/run_blackbox_tests.py workflow` passed in141.7s, exit0, one domain. The log is /project/rose-speed-comparison-20261028/workflow-unchanged-rerun-20261030.log. This establishes observed recovery only, not a causal fix. Its recovered getNamespace test-server warning also appears in the previous passing run. No timeout, assertion, cache or runtime configuration was changed.
