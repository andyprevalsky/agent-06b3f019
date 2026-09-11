---
id: 2026-07-06-run-bench-used-asdf-python-missing-boto3
date: 2026-07-06
title: run-bench invoked the asdf python instead of the agents venv, so R2 reads crashed on a missing boto3
surface: harness
component: benchmark-runner
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run-bench — invoked the ambient asdf python rather than the agents venv interpreter
symptoms:
  - R2 corpus reads crash from run-bench
  - boto3 import failure in a benchmark step that works when run from the venv
  - "ModuleNotFoundError: No module named 'httpx'"
tags:
  - benchmark
  - python
  - venv
  - asdf
  - r2
sources:
  - memory:project_simulate_e2e_wired_rose_provider
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

Benchmark steps launched through `scripts/run-bench` crashed on R2 reads: the
required `boto3` dependency was missing. The same code worked when run directly
from the agents virtualenv.

## Diagnosis

`run-bench` invoked the ambient **asdf** python rather than the agents venv
interpreter. The venv has the project's Python dependencies installed; the asdf
interpreter does not, so anything importing `boto3` (the R2/corpus path) failed
only when routed through the wrapper. The symptom is an import error in the
callee, which points at the dependency rather than at the interpreter choice — the
actual defect is one level up, in which python the wrapper selects.

## Solution

`run-bench` now uses the agents venv python. Shipped 2026-07-06 with the simulate
end-to-end work, alongside `--simulate` forwarding through `run-bench`/`local.py`.
The general rule: every wrapper script that shells out to Python must select the
project interpreter explicitly rather than inheriting whatever is on `PATH`.

### September 11 cloud-controller recurrence

Proof 13 (`capability-stability-20260911201448-35774`, HEAD `cf288dd2`)
failed while importing `logs.py` from the actual `hub_upload.py`, before any
provider allocation or benchmark task. Its local launcher put Homebrew before
`agents/venv/bin`; Homebrew Python 3.13 lacked `httpx`, while the existing
Python 3.11.9 project venv loaded the unchanged helper successfully. The July
repair selected a venv only for the local Python dispatch. Cloud dispatch,
including the early `stability-proof` branch, still inherited ambient PATH.

Archive searches used `hub_upload httpx python interpreter` and
`benchmark venv PATH Homebrew`. This is a recurrence at the same wrapper
interpreter boundary, not a missing dependency declaration. The isolated import
comparison is recorded in
`.context/acceptance/fleet-startup-rca/interpreter-boundary-repro.json`.

The permanent multi-workstream test launches the actual fleet controller in a
private Git worktree. A project Python wrapper records actual Hub invocation;
its scratch `logs.py` deliberately raises a missing-module error at the same
import boundary, before outbound HTTP. The final unchanged command is:

```bash
CLOUDBENCH_TEST_STARTUP_FAILURE_ONLY=1 bash scripts/tests/cloudbench-multi-workstream.test.sh
```

Before the fix it reports `Hub upload bypassed the project Python interpreter`.
After the fleet selects its workspace venv before any dependency-bearing helper,
the same assertion passes. Both results are recorded in
`fleet-startup-rca/permanent-final-red-green.json`, with `before-final.log` and
`after-final.log`. The original native failure printer also lacked GNU
`timeout`; the assertion failures precede that diagnostic-only error. Existing
scripts-only fixtures preserve ambient Python when no venv exists, and ordinary
successful fleet scenarios remain mandatory in the full deploy controller
suite. No global dependency installation, requirements change, or live benchmark
pass is claimed by this causal proof.

The repair unifies cloud helper interpreter ownership once per controller,
including snapshot re-entry and direct fleet invocation. It adds no per-agent
work or shared coordination at 10,000 agents. The accompanying startup cleanup
failure is tracked in `2026-09-11-failed-stability-proof-abandoned-retained-fleet`.

## Human feedback

None recorded.

## Reusable lesson

When a dependency import fails only under a wrapper script, check which
interpreter the wrapper selected before touching requirements — wrappers must pin
the project venv, not the ambient `PATH` python.
