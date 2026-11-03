---
id: 2026-10-15-native-setup-reported-healthy-before-serving-validation
date: 2026-10-15
title: Native setup reported healthy before validating serving imports
surface: infra
component: world-model-setup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: setup-world-model.sh validated metadata only and wrote requirements.sha256 before runtime validation
symptoms:
  - Installer reports healthy without fastapi
  - Installer reports healthy without uvicorn
  - Failed native validation creates a healthy requirements marker
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-native-setup/result.private.json
repro: agents/benchmarks/world_model_vendor_test.py; scripts/tests/cloudbench-env.test.sh
status: open
---

## Problem

The actual Bash installer under a controlled native-Python shim reported success with Python >=3.12 and exact experiential metadata but a missing serving module. Cached/override paths skipped installation and exposed the same incomplete validation.

## Diagnosis

The native server imports FastAPI and runs uvicorn, but setup only asserted Python and distribution version. Normal installation wrote its healthy digest marker before running that validation. The shim executes the real stdin validation code; it is not evidence of operational native-model admission.

## Solution

Setup now imports fastapi and uvicorn on override, cached and fresh paths after retaining the exact 0.7.158+rose.bf75987e assertion. Overrides never trigger upgrades. A normal requirements marker is committed only after validation succeeds. Combined installer proof went 2 FAIL / 2 PASS to 4 PASS with identical tests; the narrow existing cloudbench callback passed with faithful vendor inputs and preserved two-fake-uv/bad-Python assertions. Parent then reported all five vendor tests passing and a read-only actual Python 3.12 override validation passing, without install/rebuild. Full deployment gates remain pending.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `04199d309ed0dda7347eea20b39f22b035c44dc80fd9e29fbac7e4f6c97f2513`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Validate the runtime imports required to serve before returning an interpreter or writing a healthy-install marker.
