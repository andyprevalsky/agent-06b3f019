---
id: 2026-11-16-text-merge-duplicated-benchmark-quarantine
date: 2026-11-16
title: A text merge combined two valid quarantine markers into duplicate JSON keys
surface: harness
component: benchmark-catalog-quarantine
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: PR2289 merge e42554d8 combined independent browser-biometrics-webdecoy quarantine members before and after title in tasks.json
symptoms:
  - "DEPLOY_CLOUD BLOCKED: browser-biometrics-webdecoy: duplicate JSON key 'quarantine' in agents/benchmarks/tasks.json"
  - "ValueError: browser-biometrics-webdecoy: duplicate JSON key 'quarantine'"
  - auth-test-site-benchmark FAIL
  - missing complete case receipt
tags:
  - quarantine
  - catalog
  - json
  - merge
  - smoke
sources:
  - PR #2411
  - PR #2289
  - PR #2279
  - commit e42554d8e06e43adb932a14b4984fecb7153abfb
  - commit ff7e91bea47cc1784931a3fb919ae8d3ac4819ca
  - commit c04bacf96b8293782ec8810fed66561448f6a289
  - commit 3b77f392d0d26a6340d795689bfa5a90bd948110
repro: scripts/tests/deploy-test-quarantine.test.py (RepositoryCatalogQuarantine.test_repository_catalog_is_strict_and_quarantines_validate)
status: open
---

## Problem

PR2411's native smoke adapter exited2 before launching any campaign because
browser-biometrics-webdecoy had two quarantine members. All seven selected
smoke cases remain UNVERIFIED; its original incomplete receipt and
lingering_group=true are preserved. Namespace absence and the immutable code
path establish pre-allocation refusal, not a test pass or resource-release
receipt. The same strict loader also failed six auth-test-site-benchmark cases
in agents coverage; no second independent runtime defect is inferred.

## Diagnosis

```text
PR2279 COST_LIMIT marker + PR2289 timeout marker (both valid)
  -> textual merge e42554d8 (two members at different positions)
  -> strict catalog loader rejects duplicate JSON property
  -> smoke adapter returns2 before capacity/namespace/provider admission
  -> incomplete native receipt; selected task outcomes UNVERIFIED
```

Each real merge parent passes the actual strict reader (exit0). The merge,
PR2411 base780ec1dc and failedc04bac catalogs all fail (exit2) with stderr
byte-identical to native smoke. Catalog and reader bytes match across base and
failed source; crossed reader/catalog controls prove the data boundary. The
actual long_horizon.load_raw_catalog path independently fails identically on
base and failed source, matching the agents-domain error. Gate NOT_INTRODUCED
by PR2411; this release explicitly owns the critical repair and rerun rather
than waiving it.

The earlier ff7e91bea4 repair already consolidated duplicate markers and added
strict refusal controls. This is a recurrence of that text-merge metadata
class: the reader correctly refused, but existing tests asserted refusal of a
synthetic bad object and did not validate every subsequently merged real
catalog. Archive searches included `duplicate JSON key quarantine`,
`browser-biometrics-webdecoy COST_LIMIT quarantine`, `duplicate quarantine
textual merge` and `Tilion smoke markers PR1910 PR1981`; no same-cause archive
case was located, while the direct prior Git repair is retained as provenance.

Before editing, the original COST_LIMIT owner and PR2289 successor received
actual evidence. The successor confirmed this metadata repair had no existing
owner and asked this thread to own it. Underlying COST_LIMIT and420s timeout
repairs remain independently owned; their errors, evidence and repair links
are retained. This correction does not claim either browser flake is fixed.

## Concurrent repair reconciliation

Before landing, current main1de49a7132 was inspected at exact catalog blob
8dfeb27831338f3ad14ce2b803a22d60eda64937. Upstream3b77f392d0 had already
removed the overwritten COST_LIMIT member and extended the existing benchmark
regression to validate both real catalogs. Its owner independently confirmed
ordinary last-key parsed semantics were preserved, and that this did not
resolve COST_LIMIT or timeout runtime failures. The strict current catalog
passes220 tasks; the COST_LIMIT incident was present only in Git/private
receipts, while the active marker retained timeout and a pending owner.
This release preserves upstream's strict regression and both runtime incidents
in one active metadata record. It does not claim sole ownership of the already
landed serialization fix. Actual repair owners remain ph7dks458a5md98rqzhab8wafn8jaypb
and ph77fvbp3fna54x71mn0523e2d8jaxc1. Their benchmark work is independent.

## Solution

Consolidate into one validated four-field quarantine object, retaining both
complete errors/evidence and both actual repair links. Preserve since, active
quarantine, task prompt, tools, timeout, evaluator and budget. Add a real-catalog
strict-read assertion to the existing deploy quarantine structural suite.
The unchanged assertion fails on the captured catalog (exit1), then passes on
the consolidated catalog (exit0), including five unchanged runs; existing
duplicate-key and malformed-marker negative controls still pass. The live
owning suite passes43/43 after application.

This suite is consistently run by deploy-command-structural; it is not ordered
before paid smoke. The adapter's existing strict preflight remains before any
allocation. No new serialization, parser fallback, last-wins behavior or
exception to test outcomes is added. At10,000 agents there is no runtime agent
path change; catalog validation is deploy/controller work. Golden reference:
not applicable (operational metadata and validation, no model-visible change).
Production deployment remains pending.

## Human feedback

The user required completion through deployment and reconciliation with actual
existing bug owners before repair. No user authorized changing benchmark
prompts, evaluators, budgets or timeouts; those remain unchanged.

## Reusable lesson

Validate the complete merged catalog with its strict production reader while preserving all quarantine incident metadata.
