---
id: 2026-10-16-worker-path-filter-guard-required-one-yaml-quote-style
date: 2026-10-16
title: Worker path-filter guard rejected valid YAML quote normalization
surface: infra
component: deploy-workflow-structural-guard
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: workflow-deployment-migration.test.sh checked single-quoted YAML source text instead of the worker path exclusion values
symptoms:
  - "FAIL: additive agent tests must not trigger a production worker replacement"
  - Valid double-quoted push exclusions failed a single-quoted source-text check
tags:
  - deployment
  - structural-tests
  - yaml
sources:
  - task .context/deploy-rejected-caps-20261015
  - task scripts/tests/workflow-deployment-migration.test.sh
  - task .github/workflows/deploy-agents.yml
repro: bash scripts/tests/workflow-deployment-migration.test.sh
status: fixed
---

## Problem

The C8 full deploy structural gate failed after formatting the incoming deployment
workflow. Both test and benchmark exclusions remained in the actual push path
list, but the structural test searched for their single-quoted spellings while
Prettier emitted double quotes. The production workflow policy was unchanged.

## Diagnosis

The literal error and the behavioral query for YAML/formatting structural checks
were searched in the RCA archive. The manual deployment recovery case from
2026-10-15 explains the incoming workflow change; the structural-boundary cases
from July are related lessons. None establishes this failure without a repro.
The first bad boundary is the test's representation-sensitive assertion.

The same complete registered shell suite fails on the current double-quoted
workflow and passes with the candidate guard. It also passes a private copy with
single-quoted paths. Removing either exclusion, replacing the actual on event key, hiding an
exclusion in a comment, or re-including agents after the exclusions remains
a failure. No native provider call is made: the suite
uses its existing fleet and cooperative-deploy fakes.

## Solution

Parse the actual YAML push path list with the already-installed YAML loader,
accept either quote style, require the runtime include, and require both
exclusions after its last occurrence. BaseLoader keeps the on key a string.
PyYAML is already required by the mandatory huggingface-hub dependency; no
requirement or installation change is introduced.
Keep the workflow, runtime classifier, dispatch source guard, deployment owner,
activation policy and budgets unchanged. The owning assertion remains in the
existing registered workflow-deployment-migration deploy structural suite.
This test-only change adds no per-agent work or production behavior at 10,000 agents.

## Human feedback

Preserve deployment safety contracts and fix the first incorrect boundary.
A formatting change must not be reported as a missing production exclusion.

## Reusable lesson

Test the configuration value and its effective ordering instead of one formatter's
choice of quote characters.
