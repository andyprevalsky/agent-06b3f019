---
id: 2026-10-28-deploy-stage-file-spec-lost-sibling-import
date: 2026-10-28
title: File-spec loading of deploy_stage could not resolve its sibling metadata module
surface: harness
component: deploy-stage-module-loading
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_stage.py imported factory_metadata by ambient module name although its supported file-spec caller does not add scripts to sys.path
symptoms:
  - "ModuleNotFoundError: No module named 'factory_metadata'"
  - "test_deploy_summary_separates_parallel_overlap_from_gaps"
  - "predeploy-metrics"
tags:
  - python
  - module-loading
  - deploy-metrics
  - file-spec
sources:
  - commit 4c118e0de38c3a0c3f3b1dd93d3b30d89d099608
  - plan:.context/deploy-fresh-20261027/rca-predeploy-metadata-import/REPORT.md
  - plan:.context/deploy-fresh-20261027/rca-predeploy-metadata-import/FINAL.json
  - plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/recurrence-940d/independent-sibling-review.json
repro: agents/tests/blackbox/predeploy_metrics.blackbox.py::test_deploy_summary_separates_parallel_overlap_from_gaps
status: fixed
---

## Problem

The fresh agents coverage run on940d failed predeploy-metrics before its interval
arithmetic assertions. The existing test loads scripts/deploy_stage.py by file
spec; its new bare factory_metadata import raised ModuleNotFoundError. The
ordinary command-line timeline path passed. This was a module-loading defect,
not an interval-math or host-load diagnosis.

## Diagnosis

A file-spec load does not add the loaded module's sibling directory to sys.path.
The shared deploy-stage module assumed the command-line import environment.
The first bad boundary was that ambient import lookup; no metadata parsing or
numeric summary check had executed in the failing test.

Archive searches used factory_metadata, file-spec imports, and the literal
ModuleNotFoundError. No matching incident was found. The existing
2026-10-13-stdlib-parent-attachment-logging-contract case was read as a related
boundary-contract example, not treated as evidence of this cause. Existing
scripts/cloudbench_result.py and cloudbench-aggregate-runs.py provide the exact
sibling-loader pattern used here.

## Solution

Load the exact sibling factory_metadata.py using importlib.util and bind its
load_metadata export. Do not alter sys.path or install a global module entry,
fall back to a foreign module, or suppress a missing sibling/internal dependency
error. Metadata normalization, lifecycle and summary arithmetic are unchanged.

The identical native command in the same private active/agents directory was:
`/home/boxes/rose/agents/venv/bin/coverage run --parallel-mode scripts/run_blackbox_tests.py predeploy-metrics`.
Original source9bec21f0 exited1 in15.745s:8PASS/1FAIL with the exact import error.
Final candidate4be4eaf7 exited0 in10.294s:9PASS. Every existing test byte and all51
assertions were unchanged, including wall120.0s, sum30.0s, overlap10.0s and
gap100.0s. Additional isolated controls verify exact sibling selection despite a
foreign global factory_metadata, unchanged sys.path/sys.modules, and propagated
missing-file and nested-import errors. Signal-cleanup and log-streaming cases
passed. Native child commands joined and were absent; no service, DB, provider
or credential operation ran. An earlier private copy setup error and preformat
candidate are retained separately and excluded from final byte proof.

Patch744ea1018bf21f52c0b653529cde600008c6847f3d18fbf84c093a6e7158628b
was independently reviewed and applied in4c118e0d. This fixes the proven import
boundary. The4c118 predeploy-metrics native owner subsequently passed in9.591s.
The full123-domain aggregate still failed the separate config-identity fixture;
whole-devbox and production acceptance are not claimed by this case.

## Human feedback

None recorded.

## Reusable lesson

Resolve a supported file-spec module's required siblings from its own path rather than relying on its caller's ambient module search path.
