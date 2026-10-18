---
id: 2026-10-16-native-install-inherited-caller-directory-for-relative-wheel-links
date: 2026-10-16
title: native install inherited caller directory for relative wheel links
surface: infra
component: world-model-setup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: setup-world-model.sh invokes uv pip install from caller cwd with relative manifest find-links
symptoms:
  - Older uv resolves vendor/world-model from repository root instead of agents
  - CONTROL vendored find-links directory missing under arbitrary caller cwd
tags:
  - deploy-review
  - regression
  - wmh
sources:
  - PR #1453
  - commit f204831d1b8bfe8197b617901f5126964ec34740
repro: agents/benchmarks/world_model_vendor_test.py::test_native_setup_resolves_vendored_links_under_both_uv_path_contracts
status: open
---

## Problem

C2 finding4290940154 identified conditional native-setup compatibility: requirements use relative find-links, the installer inherits caller cwd, and no uv version floor is declared. Local uv is0.12.24; this is not an actual C7 failure. No old uv binary was installed or invoked.

## Diagnosis

Path: caller cwd -> actual setup-world-model.sh -> uv requirements find-links resolver -> vendored wheel directory. Official uv PR20832 (merged2026-07-30) and0.12.1 changelog document old cwd-relative resolution versus requirements-file-relative resolution after the fix. The owning Bash control faithfully substitutes only installer/native execution and models those two documented resolver bases. Original Bash fails for root/cwd and arbitrary/cwd while requirements-relative controls pass. The first-bad owned boundary is dispatching a relative-path consumer from an unrelated cwd, not wheel integrity or Python metadata.

Two archive searches and the native wheel-integrity/serving-validation relatives are recorded. Neither prior cause recurs: authenticated bytes and validation are preserved. A version floor would add policy unnecessarily; absolute manifest paths alone cannot resolve a relative option inside it.

## Solution

The one-line repair executes only uv pip install in an agents-directory subshell. Python and requirements arguments remain absolute; wheel authentication, pip check, signature timing, cache skips and WMH_NATIVE_PYTHON no-install behavior remain unchanged. The same final registered assertions yield baseline2FAIL3PASS0.513070s and candidate5PASS0.648791s; extended eight-case family passes1.602704s, preserving all original import/version/digest/signature assertions. Five new parametrized pytest cases are collected by the existing vendor-test file, already invoked by the registered WMH blackbox family.

Golden reference: claude-code-src/src/utils/nativeInstaller/download.ts:252-258 gives npm ci an explicit staging cwd. The candidate converges on operation-owned install directories. Official uv PR20832 and changelog are the primary path-semantics golden; this is documented-resolver contract proof, not real old-uv install acceptance. Other reference repos were absent at known checkout paths and no new clone/install was permitted. No new uv floor or package version is introduced.

## Human feedback

The user requested conditional compatibility proof only, prohibited native dependency/model rebuilds, and required frozen source/private candidates while Group4 runs. Do not claim this repaired a historical gate failure on current uv0.12.24 or infer a benchmark/provider outcome.

## Reusable lesson

Run dependency installers from the directory that owns relative paths in their manifests.
