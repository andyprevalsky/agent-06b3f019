---
id: 2026-10-29-full-agents-coverage-inherited-domain-selector
date: 2026-10-29
title: Full agents coverage inherited a diagnostic domain selector
surface: harness
component: agents-coverage
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/scripts/run-coverage.sh passed inherited AGENTS_BLACKBOX_DOMAINS into the full runner
symptoms:
  - "A full coverage wrapper silently ran only inherited selected blackbox domains."
  - "AGENTS_BLACKBOX_DOMAINS"
tags:
  - coverage
  - review-stabilization
sources:
  - PR #1627 review5702909858 comment4416297247
  - commit 385c93722ffbc4f62152ff99a166fa1321ace920
repro: agents/venv/bin/python -m pytest agents/tests/unit/test_coverage_blackbox_parallel.py -q
status: open
---

## Problem

A full coverage wrapper silently ran only inherited selected blackbox domains.

## Diagnosis

The selector belongs to direct diagnostic runs. The full wrapper inherited it unchanged, while discovery filtered the inventory and the summary did not name the run as partial.

Archive searches used inherited selector/partial coverage and inbox stale
snapshot vocabulary. The October28 coverage-map-completeness case is related
but guards a different consumer; it does not cover this first bad boundary.

## Solution

Clear AGENTS_BLACKBOX_DOMAINS at the full wrapper invocation. Preserve direct diagnostic selection and mark its summary partial with selected_domains. The real wrapper is executed against local fake Python/coverage boundaries, while the diagnostic tests exercise the real discovery and async runner.

The identical complete owner unit file fails before with6pass/2fail and passes8/8 five times after. No browser install or provider call runs in these fixtures.

The exact source-bound temporary candidate/report, commands and sealed logs
are under `/var/tmp/deploy-1627/review385c-runtime/`. Combined candidate SHA256:
`f1d4e045cf2c52d5a9d74fddac31ce9c7bf1b9cffedd45af912bf463c4ef18b0`.
No source application or live/full-gate passing outcome is claimed. Parent
conditional technical approval and offline proof do not replace integration
validation; this case remains OPEN until the owner completes it.

## Human feedback

Preserve full inventory, thresholds, budgets and original failure evidence;
prepare only temporary candidates while the sole source owner runs frozen
checks. Keep Freedom unchanged. Direct diagnostics remain supported and must
not masquerade as full coverage evidence.

## Reusable lesson

Give each full-gate boundary an explicit complete-inventory contract and test
its negative case at the actual owning command.
