---
id: 2026-10-15-agentcard-skip-classified-independent-native-retirement-as-skipped
date: 2026-10-15
title: Conditional AgentCard waiver could classify an independent native join failure as skipped
surface: harness
component: benchmark-native-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_benchmark.py general exception handler chose release_skip before retiring the owned native world
symptoms:
  - Native WMH retirement failed but status remains SKIPPED
  - Conditional typed release stall masks independent native cleanup status
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-retirement-skip-classification/result.private.json
repro: agents/tests/blackbox/benchmark.blackbox.py test_agentcard_release_skip_rejects_independent_native_retirement_failure
status: open
---

## Problem

A conditional offline public-owner replay returned SKIPPED after recording an independently failed native join. This was not observed as a current deploy failure or attributed to an earlier run.

## Diagnosis

The exception handler selected the permitted payment waiver before native retirement, swallowed the retirement exception so cleanup could continue, and promoted ERROR only for another evidence-error list. Native diagnostics were added later. Crucially, the replay programmatically adds a valid native seed and simulate mode to a payment task. The unchanged merged catalog has no payment/native-seed intersection, and the CLI seed-file guard rejects the payment catalog mode. Operational reachability through current CLI/default tasks remains unproved.

## Solution

The defensive correction promotes a recorded native retirement error to ERROR before archive/publication, retaining payment/native diagnostics and the one-time financial cleanup waiver. The same conditional owning assertions failed baseline (exit 1, 0.824s) and passed candidate (exit 0, 0.782s); four payment controls and a native successful-join golden also passed. Parent later executed six owning merged callbacks successfully. These are component/conditional proofs, not unchanged-catalog trigger proof or evidence of actual financial cleanup.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `22facab06b1869dc30f902382aead24b97a86bf385e611743e11f9f7f71110a6`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Keep independent cleanup failures strict while stating whether the combined triggering configuration is operationally reachable.
