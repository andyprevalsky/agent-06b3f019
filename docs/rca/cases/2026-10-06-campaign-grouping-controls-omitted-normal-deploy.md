---
id: 2026-10-06-campaign-grouping-controls-omitted-normal-deploy
date: 2026-10-06
title: Campaign grouping controls ran in the CI script but normal deploy omitted their family
surface: harness
component: deploy-structural-gate
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-deploy-structural-gates.py GATES omitted campaign-hub-grouping.test.sh while scripts/test.sh registered it
symptoms:
  - normal deploy did not admit the real HTTP scheduler grouping controls
  - a green frontend coverage run did not exercise the scheduler grouping owner
  - the root CI registry and the normal deploy registry covered different compact families
tags:
  - deploy-gate
  - test-registration
  - campaign
  - hub
sources:
  - commit 794854094523e07b471e887e755b0b14aaa26d65
  - commit 794854094523e07b471e887e755b0b14aaa26d65:scripts/run-deploy-structural-gates.py
  - commit 794854094523e07b471e887e755b0b14aaa26d65:scripts/tests/run-deploy-structural-gates.test.py
  - commit 794854094523e07b471e887e755b0b14aaa26d65:scripts/tests/campaign-hub-grouping.test.sh
repro: scripts/tests/run-deploy-structural-gates.test.py StructuralGateDocumentationTests.test_compact_benchmark_gates_are_always_registered
status: open
---

## Problem

The six compact campaign scheduler/API controls were registered in scripts/test.sh,
but normal /deploy Step 4s called a separate dispatcher without that family.
The frontend component controls and the Python live-result selection did not
replace these actual scheduler, gzip uploader, Express route and storage-owner
controls. Retained manual passes therefore did not guarantee future deploy coverage.

## Diagnosis

Before changing production, the archive was searched for “campaign hub grouping
missing deploy registration” and “owning regression suite registered scripts test
omitted normal deploy dispatcher”. The October 1 agents-structural registration
case is related through the split manual registries. The October 6 campaign
schedule case owns the grouping behavior; its original unpublished-schedule cause
is distinct from this missing deployment registration.

The existing compact-registry test was extended with the already existing grouping
command. Its unchanged canonical-runner observation failed on the original 44-entry
registry and passed on the private 45-entry candidate. The other two existing
documentation/registry agreement assertions also passed, with identical test bytes
between RED and GREEN. The actual canonical admission driver rejected the original
registry before execution because that exact family was absent.

## Solution

Add one existing-family entry to GATES, include its exact command in the existing
compact benchmark registration assertion, and list it in Step 4s as required by
the existing two-way documentation checks. All dispatcher functions and admission,
concurrency, signal and cleanup behavior remain unchanged. There is no new test
family, paid workload, stress run or mandatory LIVE fifty-copy gate.

Canonical admission executed the unchanged six-control family successfully: six
passes, zero failures or skips, EXIT0 and 2.932 seconds. It used pinned Node 22.13.0,
the supported backend dependency owner and exact final-source helpers. A prior
private adapter omitted two unchanged sibling fixtures and produced ENOENT; that
zero-credit attempt was preserved and its positively owned local test processes
were retired. Correcting only fixture relocation yielded the native result.

The normal final 45-family dispatcher and deployment qualification remain pending,
so this case is OPEN. The compact control supplies no fleet performance, paid
execution, provider-release or production frontend acceptance credit.

## Human feedback

The user required updated benchmark regressions to run through normal deployment
instructions, compact permanent coverage, and autonomous progress without
unnecessary large validation runs. Operational deployment wiring was authorized;
no prompt, model, task, evaluator or cache result changed.

## Reusable lesson

A test registered in a CI script is not automatically registered in the normal
deployment dispatcher. Bind each compact owning family to the actual dispatcher
registry and keep its operational documentation checked in both directions.
