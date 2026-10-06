---
id: 2026-09-30-browser-navigation-contract-missing-dependency-floor
date: 2026-09-30
title: Native browser navigation was assumed without a compatible dependency floor
surface: agents
component: browser-use-navigation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/requirements.txt admitted browser-use 0.11.13 after the legacy global navigation patch was removed
symptoms:
  - browser_navigation_uses_event_timeout_without_global_patch failed
  - nav_timeout = 20.0
  - actual CDP navigation budget was 20 seconds despite the configured 300-second event budget
tags:
  - browser-use
  - dependency
  - timeout
  - blackbox
sources:
  - PR #1299
  - PR #1312
  - commit 9d44d054cae4ed89eea11c6a469697a881583683
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py:test_browser_navigation_uses_event_timeout_without_global_patch
status: fixed
---

## Problem

The first canonical agents coverage gate after the main integration failed the
registered browser navigation contract. The installed browser-use was 0.11.13;
requirements still admitted any release from 0.11.0. Main removed the old
process-global asyncio patch while assuming browser-use itself forwarded the
configured event budget. The original failed gate is preserved; it is not
relabelled by focused checks.

## Diagnosis

An offline owning test calls the installed `BrowserSession.on_NavigateToUrlEvent`
and its actual `_navigate_and_wait` through a fake CDP transport. Observing only
the browser-use module's asyncio binding records the real Page.navigate budget,
without mutating global asyncio. On 0.11.13 it fails with `AssertionError: [20.0]`
against the unchanged 300-second configured event budget. The identical test
passes with the hash-verified official 0.12.6 wheel. Wheel source inspection
shows 0.12.5 lacks event-budget forwarding and 0.12.6 adds it.

The original test inspected a source substring. That assertion also rejects
newer correct upstream versions because their optional navigation argument still
has a 20-second default; the event handler now passes the actual event budget.
The missing dependency capability and the source-text proxy were separate errors
at the same integration boundary. No runtime global patch is needed.

Archive searches for `nav_timeout = 20.0 Page.navigate` and `AMC navigate timeout`
found the August26 benchmark timeout batch and September10 CDP latency evidence
gap. Neither established this dependency boundary; this is a new integration
case. The original failure, dependency sources, immutable test hashes, and private
RED/GREEN receipts live under `.context/acceptance/proof84-agents-contract-rca/`.
The owning command is, from `agents` with the existing venv active,
`python /Users/andyprevalsky/Developer/rose-pr1299/.context/acceptance/proof84-agents-contract-rca/run-owning.private.py browser-owning-red`. A verified wheel overlay selects only the dependency for the GREEN
control. Initial focused times were 0.686 seconds RED and 0.672 seconds GREEN.

## Solution

Pin browser-use to the verified 0.12.6 release that forwards the event deadline, and replace the
source-string proxy with the existing registered owning runtime test. It checks
actual CDP invocation, the configured budget, and unchanged global asyncio.
The 300-second event configuration, models, prompts and evaluator behavior remain
unchanged. Actual environment adoption used a dry-run resolver plan and a complete installed
metadata comparison. Version 0.12.6 pins its dependency graph; the resolver
required 31 exact package changes, including compatible instructor and
huggingface-hub releases. The installed changes match that plan exactly, and
`pip check` is clean before and after. No unrelated package was changed.
The [official release](https://pypi.org/project/browser-use/0.12.6/) wheel hash,
resolved package list and complete before/after inventories remain private.

The final identical browser test file fails on the verified 0.11.13 control in
1.378 seconds and passes on actual installed 0.12.6 in 1.375 seconds. The existing
coverage runner passes all 627 browser cases in 49.331 seconds and all 201 Rose
cases in 10.435 seconds, each with its unchanged 300-second domain budget. An
initial domain attempt correctly rejected the newly async test's stale sync
registration; that failed receipt is retained, and the permanent registration now
awaits `record_async`. The other 643 browser and 213 Rose declarations are
AST-identical to the integrated baseline. No new test suite was added.

Root independently reviewed the three-file diff and the owning assertions. Cloud
adoption of the compatible resolved package graph remains a deployment gate;
Linux may select platform-specific wheels. These focused tests provide no cloud
benchmark acceptance credit.

## Human feedback

The user requires robust existing verification without a massive new suite,
zero infrastructure failures in the final cloud proof, and no timeout increases.

## Reusable lesson

Declare the dependency capability a removed compatibility shim relied on and verify its runtime contract instead of matching upstream source text.
