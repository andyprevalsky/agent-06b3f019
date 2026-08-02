---
id: 2026-07-24-deploy-suite-invoked-on-unhydrated-runner
date: 2026-07-24
title: Auto RCA ran the full local /deploy suite on a bare Actions checkout with no dependencies, venv, or Postgres
surface: harness
component: auto-rca-workflow
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto RCA workflow — it invoked the full local `/deploy` suite before hydrating the developer environment it requires
symptoms:
  - both /deploy offline attempts fail broadly inside an Auto RCA run
  - fresh Actions runner has no repository dependencies, agent Python venv, mac-app dependencies, or local Postgres
tags:
  - auto-rca
  - github-actions
  - deploy-gate
  - environment-hydration
  - postgres
sources:
  - PR #885
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production Auto RCA run 30066395611 did everything right up to the gates: evidence
collection passed, a 17m3s primary investigation completed, trusted checkpointing
worked, and the unchanged pre/post reproduction ran. Then **both** `/deploy` offline
attempts failed broadly, because the fresh Actions runner had no repository
dependencies, no agent Python venv, no mac-app dependencies, and no local Postgres.

## Diagnosis

The workflow invoked the full local `/deploy` suite on a bare GitHub checkout, even
though that suite is written against a hydrated developer environment. Every offline
gate that touches node_modules, the agents venv, or the local database therefore failed
for the same environmental reason — a broad, undifferentiated failure that looked like a
code problem but was an unmet precondition of the harness.

## Solution

The workflow now hydrates root/workspace, mac-app, and agent Python dependencies before
starting the investigator, and provisions an isolated Postgres 16 service plus the local
test env the offline gates need. Environment setup is recorded as its own human-readable
RCA waterfall step so a hydration failure is legible instead of appearing as mass gate
failure. At 10k agents, setup remains isolated per queued Actions run — no shared runtime
state and no production hot path is added. Verified by
`scripts/tests/auto-rca-workflow.test.sh`,
`scripts/tests/auto-rca-lifecycle.blackbox.test.sh`, the approval guards, workflow YAML
parse, and `git diff --check`.

## Human feedback

None recorded.

## Reusable lesson

Before running a locally-written test suite in CI, hydrate every precondition it assumes
and record hydration as its own visible step — otherwise a missing venv or database
presents as a broad, misleading gate failure.
