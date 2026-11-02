---
id: 2026-10-28-factory-failure-class-used-negative-control-log
date: 2026-10-28
title: Factory failure classification mistook expected negative-control logs for the failed domain outcome
surface: harness
component: factory-metadata
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/factory_detail.py scan_log selected a network hint from anywhere in test output as the final stage failure class
symptoms:
  - "agents stage failure_class=network with no failing domain names"
  - "completed domain inventory says 121 passed and 2 failed"
tags:
  - factory
  - telemetry
  - diagnostics
sources:
  - PR #1627
  - commit 11ba1f13b2cefc9b6a818263ac2b7700c4af9e73
repro: scripts/tests/factory-metadata.test.py::FactoryDetailTest::test_explicit_domain_failure_wins_over_expected_network_logs
status: open
---

## Problem

The completed agents coverage attempt at 20:22:39 UTC had failed domains
benchmark and rose-browser-use, but its stage detail said network with no names
or domain counts. Expected negative-control Connection refused text appeared
inside the log. Original receipts and raw logs remain unchanged.

## Diagnosis

Source path: domain outcomes -> coverage runner inventory/log -> stage detail
scanner -> outcome.failure_class -> factory report grouping. The first wrong
boundary was treating a matching substring anywhere in the mixed log as a
proven final failure class. The old parser maps the actual recorded log to
network; the completed runner inventory independently records121pass/2fail.
The new test reproduces the mismatch with that exact inventory and expected
negative-control line. Before exits1 in0.116s; after five unchanged runs pass.

Archive searches: 'factory failure_class network Connection refused' and
 'telemetry negative control misclassified runner outcome'. Searches returned
related reporting and environment cases but no same boundary; exact filename/
field search found no prior factory_detail incident. Searches were recorded
after the initial candidate, not retroactively represented as earlier work.

## Solution

Proposed, not applied: emit a structured failure inventory only when the agents
coverage runner finishes with failed domains. The stage reader accepts it only
as the final nonblank line, with supported runner, nonboolean counts,
consistent totals and unique safe names. It reports test-failure and
runner-summary provenance, domain counts and bounded failing names; an earlier
regex hint remains explicitly unverified. No test verdict, timeout, coverage
threshold or model decision changes. A stale/nonterminal or malformed marker
cannot override a later result.

Independent owner review found the first candidate accepted stale markers.
Candidate1 is retained; the new terminal-marker regression fails there, then
all five focused tests pass five unchanged runs after the correction. The
producer/consumer test executes actual async_main with isolated fake domains,
checks the original exit1 and results.json, and proves expected network logs do
not replace the terminal inventory. The unchanged count and secret-safe-name
checks also pass. Original artifacts: /var/tmp/deploy-1627/metadata-failure-rca.

Proposed permanent regressions are added to the already registered
scripts/tests/factory-metadata.test.py. Full registered metadata and deploy
structural suites remain required after source application. Case remains open
until owner application and broader verification. Golden reference not
applicable: ordinary metadata code/tests, no prompt approval hunk.

## Human feedback

The user requested default metadata useful for optimizing deploy, RCA,
descend and benchmark, including gate failure reasons. The user also requires
unchanged full final checks. No original stage failure was converted to a pass;
no raw old receipt was rewritten and no causal diagnosis is inferred from a
negative-control message.

## Reusable lesson

Give the owning runner's terminal inventory precedence over mixed diagnostic
logs, and retain log-pattern hints as unverified rather than causal facts.

## Integration application

Reviewed correction applied by the sole deploy source owner after the frozen interim checks ended on 2026-10-28. Original failed/interrupted receipts remain unchanged. Five unchanged owning verifications and the full final deploy gates are required before closure; status remains open until verified.
