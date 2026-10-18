---
id: 2026-10-18-phone-benchmark-import-preceded-cli-path-setup
date: 2026-10-18
title: Phone benchmark import ran before the CLI configured its module path
surface: agents
component: benchmarks/run_benchmark.py
classification: our-bug
problem_class: other
first_bad_boundary: The new benchmark helper import preceded the existing sys.path initialization
symptoms:
  - Direct CLI startup raised ModuleNotFoundError for benchmarks
  - Module-imported owning tests passed despite the broken script entrypoint
tags:
  - phone-harness
  - benchmark
  - imports
sources:
  - task PH-6D critical iPhone attention validation
  - commit 5007e66ccc6baba2702f1cd81761b6492d04d60d
repro: agents/benchmarks/phone_connectivity_test.py::test_critical_attention_cli_entry_without_pythonpath
status: fixed
---

## Problem

While preparing the approved critical-attention test, the new helper was imported
before `run_benchmark.py` inserted the agents directory into `sys.path`. Importing
the runner as a module worked, but invoking the actual script from another
directory with an empty `PYTHONPATH` failed before argument parsing. No live phone
run had started with this candidate.

## Diagnosis

The direct command was `PYTHONPATH= /home/boxes/rose/agents/venv/bin/python
/home/boxes/rose/agents/benchmarks/run_benchmark.py --help`, from `/tmp`.
It exited 1 at the new import with `ModuleNotFoundError: No module named
'benchmarks'`. Evidence: `.context/phone-harness/ph6d-cli-entry-red.log`.

The new permanent owning regression reproduced the same failure in 0.43 seconds
before the fix. Its temporary working directory and empty `PYTHONPATH` remove
the accidental import context supplied by the module-based test runner.
Evidence: `.context/phone-harness/ph6d-cli-owning-red.log`.

Archive search was `sys.path import CLI benchmark`; the related
`2026-09-27-browser-module-import-block-split-by-helper` case concerned source
layout and linting rather than a direct-entrypoint import failure.

## Solution

Moved the new import alongside the existing benchmark imports, after the
existing path initialization. Fixed the three new import-order lint findings
without changing prompts, limits, assertions, or runtime phone behavior.

The unchanged owning test passed in 0.82 seconds; the exact direct command also
exited 0. The complete owning phone suite then passed 38 tests in 5.12 seconds.
Evidence: `ph6d-cli-owning-green.log`, `ph6d-cli-entry-green.log`, and
`ph6d-owning-root-final.log` under `.context/phone-harness/`. The regression lives
in the already registered `phone_connectivity_test` suite used by the normal
benchmark blackbox domain. The broader normal gate is tracked separately.

At 10,000 production agents this adds no phone access, query, prompt, or polling
work. It restores the benchmark CLI's existing entrypoint contract.

## Human feedback

The user approved PH-6D after clarifying the repository's benchmark approval
rules. No separate feedback was recorded for this import defect.

## Reusable lesson

Test script entrypoints from outside the repository with inherited module-path
shortcuts removed. A successful module import does not prove direct CLI startup.
