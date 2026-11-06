---
id: 2026-10-28-registered-gate-omitted-from-deploy-command-list
date: 2026-10-28
title: A new registered structural gate was missing from the required deploy command list
surface: harness
component: deploy-structural-registry-documentation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-deploy-structural-gates.py registered final-review-script-regressions but the parallel explicit Step 4s command list in .claude/commands/deploy.md omitted its command
symptoms:
  - 'deploy.md Step 4s is missing registered gate(s)'
  - 'python3 scripts/tests/final-review-script-regressions.test.py'
  - 'test_deploy_md_lists_every_registered_gate'
tags:
  - deploy
  - structural-tests
  - registry
  - documentation-drift
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: python3 scripts/tests/run-deploy-structural-gates.test.py StructuralGateDocumentationTests.test_deploy_md_lists_every_registered_gate StructuralGateDocumentationTests.test_deploy_md_lists_no_unregistered_gate
status: open
---

## Problem

An independent continuation owner reported that the newly registered
final-review-script-regressions gate lacked its literal command in deploy.md.
The sole execution owner reproduced this on clean c8b8aeb2d using the two
unchanged bidirectional registry/documentation checks. One failed and one
passed in 0.122 seconds; the failing assertion names exactly the omitted
command. Original output is preserved in
/var/tmp/deploy-1627/c8-structural-doc-registry-before.log.

The gate is already registered and runs. This incident is a documentation
parity failure, not evidence that the fifteen new regression tests were
skipped by the actual runner. No completed full structural pass is claimed
on the defective source.

## Diagnosis

The owning test obtains the runner's complete command registry and requires
every command to occur as an exact inline code string in deploy.md. Its
reverse assertion rejects documented commands absent from the registry.
Adding the new Gate entry without updating Step 4s violates that established
contract. The first bad boundary is the missing second half of this explicit
registration update. The parser and existing assertions correctly detect it.

The archive search used registered gate, deploy.md and Step 4s. Related cases
2026-10-01-agents-structural-suites-never-ran-in-deploy and
2026-10-26-resume-export-read-checked-in-collector-as-private-input concern
suites absent from execution. This incident differs: execution is registered,
but its mandatory human-readable command inventory is stale. Their failures
and fixes remain unchanged.

## Solution

The temporary candidate adds exactly one literal command to Step 4s:
python3 scripts/tests/final-review-script-regressions.test.py. It does not
remove a gate, alter either assertion, change timeout or coverage budgets, or
replace the explicit list with a pointer. No runtime code is modified.

Temporary before and after copies contain the same runner and test bytes.
The exact two-test command in the repro field fails before and passes after.
The same after command passed five repetitions, each running both directions.
Results and logs are under
/var/tmp/deploy-1627/structural-doc-list-rca/ as results.json, before-1.log and
after-1.log through after-5.log. The proposed one-line patch is proposed.patch,
SHA256 fb4be94b212f422645829adf523458bf6e43edb7e2655589f52c0beb328989ce.
The independent parent technically approved those exact bytes as operational
gate maintenance, not a new product prompt or substantive review substitute.

Status remains OPEN. At drafting, the integration source is frozen with active
full runtime suites and an open exact-head review. Application is deferred to
a safe boundary. The final full structural registry, its documentation readers,
fresh approval classification and exact-source review remain required. Runtime
receipts retained across a documentation-only correction must preserve their
original source SHA and verified unchanged inputs; no new-SHA pass or cache hit
may be fabricated. Any combined backend test change needs its own full affected
backend validation and cannot be hidden under this documentation-only rationale.

## Human feedback

The user required all applicable tests and the full final sweep to pass without
weakened guarantees. The independent parent required exact one-line scope,
unchanged original assertions, full affected structural validation, and honest
runtime provenance. No additional human permission or golden verdict was
claimed for the operational command-list maintenance.

## Reusable lesson

Update both the executable structural registry and its explicit deploy command list, then run the existing checks in both directions.
