---
id: 2026-07-26-auto-rca-completion-contract-failed-silently
date: 2026-07-26
title: Auto-RCA returned a silent nonzero when any completion-contract condition was unmet
surface: infra
component: auto-rca
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: report_contract_passes — seven independent completion checks collapsed into one silent exit status
symptoms:
  - require-complete ends red with no failed-condition message
  - an Auto-RCA PR has six report sections and a HEAD marker but remains blocked
  - the workflow cannot tell whether evidence repro offline gates or smoke gates are stale
tags:
  - auto-rca
  - observability
  - completion-contract
  - silent-failure
  - github-actions
sources:
  - PR #900
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: mitigated
---

## Problem

Production run 30170612351 completed the browser and harness-push fix, passed
offline gates twice, finalized its PR, and updated Slack, yet ended red at
`require-complete`. The contract returned no indication which state condition
was missing.

## Diagnosis

`report_contract_passes` reduced seven independent requirements to a silent
zero/nonzero result. Static analysis could prove the happy path worked but could
not recover which stored attestation failed in this run, leaving a pure
observability gap rather than a completed causal diagnosis.

## Solution

Keep pass/fail semantics unchanged but print
`rca-contract: incomplete — <reason>` for each unmet condition. The next
occurrence identifies whether the report, HEAD marker, evidence binding,
reproduction, offline gates, or smoke gates are stale.

## Human feedback

None recorded.

## Reusable lesson

Make every conjunct in a completion contract report its own failed predicate;
one silent boolean cannot diagnose durable workflow state.
