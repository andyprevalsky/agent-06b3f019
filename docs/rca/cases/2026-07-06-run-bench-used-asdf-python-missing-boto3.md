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
tags:
  - benchmark
  - python
  - venv
  - asdf
  - r2
sources:
  - memory:project_simulate_e2e_wired_rose_provider
repro: none-recorded
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

## Human feedback

None recorded.

## Reusable lesson

When a dependency import fails only under a wrapper script, check which
interpreter the wrapper selected before touching requirements — wrappers must pin
the project venv, not the ambient `PATH` python.
