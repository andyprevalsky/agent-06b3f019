---
id: 2026-09-11-predeploy-selection-ignored-production-only-eligibility
date: 2026-09-11
title: Predeploy selector admitted production-only tasks to isolated backend runs
surface: harness
component: predeploy-selection
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: select_predeploy_benches._eligible ignored the catalog production_only flag
symptoms:
  - agent-payment-production-abandonment is production-only; rerun with --prod
  - local and cloud predeploy select agent-payment-production-abandonment
tags:
  - benchmark
  - predeploy
  - production-only
  - selector
sources:
  - PR #1299
repro: agents/benchmarks/select_predeploy_benches_test.py::test_predeploy_excludes_production_only_even_with_pass_streak
status: fixed
---

## Problem

Preparing the payment cleanup diff for Group 4 produced nine selected tasks on
both predeploy surfaces, including `agent-payment-production-abandonment`.
The catalog correctly marks that task `production_only`; the runner's
`_validate_task_target` correctly rejects it on a local backend. Both local and
cloud predeploy run isolated backends, so a production-only task is incompatible
with either surface. This was a selection failure found before launching the
task, not a failed execution of its payment capability.

## Diagnosis

Critical path: changed payment paths → task catalog and passing history →
`_eligible` → category floor/path depth → predeploy launch → target validation.
The existing eligibility function rejected retired/incomplete tasks and
cloud-incompatible local-only tasks, but omitted the existing production-only
flag. A passing history therefore promoted a task that the execution layer could
never run on that backend. Filtering downstream after selection would also leave
category slots empty rather than selecting a compatible candidate.

Runtime selector receipts are `.context/acceptance/local-owner-selection-local.json`
and `local-owner-selection-cloud.json`. Archive searches were
`production_only predeploy local backend` and
`smoke selection chooses incompatible production task`. The August 12 local
smoke/prod-Hub dependency case is a relative, not a recurrence: it fixed an upload
target; this defect admits incompatible tasks before launch. Selector history
already guarded canary history, local-only surfaces and the cap, but not this
catalog flag.

The permanent regression supplies three eligible-history production-only
candidates across smoke, category canary and path depth, with normal controls.
The registered benchmark blackbox failed before repair, selecting all three
production-only candidates. The two parametrized pytest cases independently
failed for local and cloud. Their identical assertions pass after repair, and
the full selector module passes 19 tests. Evidence lives in
`.context/acceptance/predeploy-production-eligibility-rca/` as
`blackbox-{red,green}.log` and `pytest-{red,green}.log`.

## Solution

Use the catalog's existing `production_only` flag in the common eligibility
predicate before all smoke, canary and depth selection. Keep explicit production
execution available through its existing runner path. Normal smoke floors,
three-pass eligibility history, ranking, path triggers and the cap of 20 are
unchanged. Both actual selector CLI reports still select nine tasks; the normal
`agent-payment-setup-resume` candidate replaces production abandonment.

The regression is registered by
`benchmark.blackbox.py::test_predeploy_selector_rejects_production_only_tasks`,
which invokes the same fixture for both surfaces. It runs in the agent blackbox
coverage gate. No benchmark catalog, prompt, evaluator or task timeout changed;
the main agent owns the subsequent full gates and live fleet proof.

At 10,000 tasks this adds one local flag check to the existing eligibility pass.
It introduces no new provider requests, database queries, history policy or
global cap. The shared predicate unifies eligibility for all selection routes
instead of maintaining a list of excluded task names.

## Human feedback

None recorded for this specific defect.

## Reusable lesson

Apply the catalog's execution-target eligibility before ranking candidates for every selection route.
