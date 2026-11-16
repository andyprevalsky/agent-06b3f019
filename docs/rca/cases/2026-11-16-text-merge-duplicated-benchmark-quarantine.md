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
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c
  - PR #2411
  - PR #2289
  - PR #2279
  - commit e42554d8e06e43adb932a14b4984fecb7153abfb
  - commit ff7e91bea47cc1784931a3fb919ae8d3ac4819ca
  - commit c04bacf96b8293782ec8810fed66561448f6a289
  - commit 3b77f392d0d26a6340d795689bfa5a90bd948110
repro: scripts/tests/deploy-test-quarantine.test.py (RepositoryCatalogQuarantine.test_repository_catalog_is_strict_and_quarantines_validate)
status: fixed
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
PR2411 is merged and all applicable production lanes are verified below.

## Human feedback

The user required completion through deployment and reconciliation with actual
existing bug owners before repair. No user authorized changing benchmark
prompts, evaluators, budgets or timeouts; those remain unchanged.

## Reusable lesson

Validate the complete merged catalog with its strict production reader while preserving all quarantine incident metadata.

## PR2411 delivery evidence

PR #2411 merged as `562cc8c49008708918d15ee9844ab1c8c333062c`.
The original failures and reproduction assertions above remain unchanged
historical evidence. Frozen source `4a9d224abd5bf5ab1770237f2a8097762938a876`,
digest `882008a4bc15beb817e758c96fd6fcabb8c9fddfcfd52454d9877be30fab17c0`,
passed all 17 selected native deploy gates. The original cycle and report
are preserved under `.context/rca-147bb3eb/validated-4a9/` and
`validated-4a9-report.log`; the report command exited 0.

The first production attempt failed semantic workflow dispatch with HTTP401
at 20:22:58 UTC before creating any workflow run. Its original FAIL and null
run identity remain in `.context/rca-147bb3eb/production-first-attempt/` and
the final production receipt's semantic_history. Render, Vercel, backend probes
and Mac release passed. The credential CLI repair was separately validated
and pushed as operations commit `6e2496487add55f3416737566873573528474fd3`;
its 91-test `/push` is not PR2411's 17-gate full deploy.

The normal semantic-only retry exited 0 at 2026-11-16T20:48:30Z. Run
[43951508861](https://github.com/Rose-Ai-Labs/rose/actions/runs/43951508861)
completed all five jobs successfully. It is **PASS-verified-by-descendant**,
not an exact-source PASS: target product merge is562cc8, effective live frontend
and tested specification source is `1ec28940191764ecf435ffc38b345006269bc95b`,
and workflow execution head is6e2496487add55f3416737566873573528474fd3.
The final `.context/deploy-pipeline/production-lanes.json` records all
applicable lanes satisfied: exact562cc8 Render/Vercel, backend probes, Mac
run43946926015 (v1.1.355), and descendant-verified semantic. Fly, WMH,
workflow migration and AgentCard remain SKIPPED-not-applicable, never PASS.
The native finish command exited0 at20:49:05Z. This resolves this repaired
boundary's delivery; it does not certify unrelated runtime repairs, original
paused-session recovery, marker release or whole-workspace deletion readiness.


The metadata/strict-reader and capture-specific custody repairs shipped in
PR2411; neither fixes the underlying browser-biometrics-webdecoy runtime.
COST occurrence de7a09b9a72047a4a25d7502027d2245 remains OPEN with owner
ph7dks458a5md98rqzhab8wafn8jaypb. Timeout occurrence
dde1843d76714899ba2cff244c0a6541 remains OPEN with owner
ph77fvbp3fna54x71mn0523e2d8jaxc1. Preserve both errors, owners and evidence
in the active marker. `.context/rca-147bb3eb/quarantine-release-audit.md`
disproves interpreting raw reported streaks as release readiness: provider
identity conflation, historical-incident/branch mixing, missing failure
observations and a treasury mid-run SKIP counted as QUARANTINED_PASS prevent
that inference. No marker release is authorized or recorded here. Native17/17
is a separate gate outcome and does not close either runtime RCA.
