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

## October 1 deploy verification environment recurrence

The PR #1299 integration check used a private launcher whose PATH selected
Homebrew Python 3.13 for nested structural checks. Two evidence-publication
checks failed with `ModuleNotFoundError: No module named 'markdown_it'`; the
existing project Python 3.11 virtualenv already contained the declared package.
The other 31 structural checks passed. Selecting the existing agents virtualenv
for every nested Python process made the exact two failed checks pass unchanged
in 2.335 seconds. No dependency installation, source repair, relaxed assertion,
or timeout adjustment was needed. The original failed receipt remains retained;
the final result combines its 31 passes with only the two corrected reruns.
Independent review bound all 232 inputs and confirmed every owned launcher had
exited. This was a private verification launch error, not a fleet runtime defect.

## October 16 private Linux verification launcher recurrence

At exact source `95ca49aade3bfa221049e3767e45ebe2e8e194b3`, the private
Linux Step 4cb invocation used `agents/venv/bin/python -m pytest` without first
activating that venv for nested shell commands. The full unchanged controller
macro passed every preceding command, then its final documented five-file pytest
command reported **498 passed, 7 failed, 593 deselected in 271.79 seconds**.
Every failed traceback reached the same first-bad boundary: a shell-spawned
`hub_upload.py` imported `benchmarks/logs.py:44`, where ambient
`/usr/bin/python3` could not import `httpx`. The required dependency was already
installed in the existing agents Python 3.11 venv.

Archive searches were `ModuleNotFoundError No module named httpx` and
`private launcher PATH child python shell publication dependency`; the July 6
case and its October 1 private-launcher recurrence were the relevant lead.
This recurrence was confirmed locally, not diagnosed from that lead alone.
The exact existing regression command, from the repository root, was:

```bash
agents/venv/bin/python -m pytest -q 'agents/benchmarks/cloudbench_dependency_sync_test.py::test_hub_transport_starting_snapshot_preserves_terminal_publication_owner[timeout-True]'
```

With the original ambient PATH this failed in 1.206 seconds at the retained
`ModuleNotFoundError: No module named 'httpx'`. After only
`source agents/venv/bin/activate`, the identical argv and assertion passed in
0.742 seconds. Interpreter/import observations and both logs are retained in
`.context/broker95ca-python-environment/{proof.json,owning-red.log,owning-green.log}`.
No dependency installation, global Python repair, wrapper/runtime/test edit,
assertion relaxation, timeout change or provider call was made.

The owned cause was a private invocation that selected the venv only for the
pytest parent, leaving nested `python3` resolution ambient. Existing source
instructions already require activation before running benchmark/controller
helpers (`CLAUDE.md`, Linux toolchain and benchmark setup). The runtime fleet
interpreter-selection repair was not bypassed or changed: these focused tests
extract individual shell functions, so their private test subprocess inherits
the caller's environment. Correcting that environment removes the import
failure without changing the deliberately tested publication/recovery outcomes.
This is the same configuration-error class as October 1, not a fleet code bug.
No new runtime architecture or golden-reference harness change was appropriate.

With that existing venv activated, the **entire same documented five-file final
pytest command**, including its full unchanged `-k` expression, passed
**505 tests, 593 deselected in 270.66 seconds**. This was not a seven-test-only
verification. The normal stage wrapper joined exit 0; its observer also joined,
and all observed exact PID births had retired. The command and its script hash
are recorded in `.context/broker95ca-python-environment/command-proof.json`;
full output is retained in the source-bound
`lantern-broker95ca-python-environment-20261016` stage log.
The original controller macro's 1739.2-second exit 1 and all its preceding PASS
commands remain immutable in `A-FINAL-FAILURE-RECEIPT.json` under the original
`lantern-broker95ca-qualification-20261016` lifecycle.

The original full macro remains exit 1; the verification disposition combines
its exact-source preceding PASS commands with the corrected complete final
pytest command. It never relabels the original macro exit 0. Existing seven
registered assertions remain permanent regression coverage. No new redundant
fixture was added. All 392 declared controller inputs and qualified runtime,
tasks, prompts and limits stay unchanged. ROOT owns source adoption, archive
reindex, aggregate runtime finish and any subsequent live gates.

## Human feedback

None recorded.

## Reusable lesson

When a dependency import fails only under a wrapper script, check which
interpreter the wrapper selected before touching requirements — wrappers must pin
the project venv, not the ambient `PATH` python.
