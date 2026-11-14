---
id: 2026-11-11-deploy-custody-required-a-donor-ledger-for-authentic-native-stall
date: 2026-11-11
title: Authentic native stall could not enter a progressed deploy without a historical donor ledger
surface: harness
component: deploy-test-historical-custody
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: historical custody admission requires an indexed donor ledger and pristine target even when authenticated original native evidence exists and the current deploy must preserve its executed occurrences
symptoms:
  - authentic native SKIPPED-stall has no corresponding preserved donor failure or custody index
  - existing donor import cannot run on the current executed deploy ledger
  - unchanged coordinator rejects prepare-recovered-stall as an unknown action
tags:
  - deploy
  - agentcard
  - historical-custody
  - no-remint
sources:
  - PR #1864
  - commit 19620e94d6b1d38efb8565ddcc0ef37e95272036
repro: scripts/tests/deploy-test-cycle.test.py Cycle.test_recovered_native_warning_preserves17_and_excludes_only_future_mint
status: open
---

## Problem

The current deploy retains seventeen failed or unverified occurrences. Its smoke inventory also selects the exact sandbox abandonment task subject to a standing no-remint instruction. The original native stall is authentic and locally available, but the four preserved original coordinator snapshots contain neither its failure row nor a custody index. Importing a fabricated donor or resetting the current ledger would change history. Executing the case again would violate the no-remint restriction.

The original native record remains SKIPPED with passed=false at source 9fa86f9ef974249609d6faec41f34cd93b50d098, timestamp 2026-11-09T16:46:15.442380+00:00 and duration 590.9 seconds. It records a closed zero-balance card, consumed 4396-cent sandbox transfer with releasedCents=0 and the corresponding held purchase. This is historical evidence; current settlement remains UNKNOWN.

## Diagnosis

Path: tracked PR1699 manifest → exact compressed/raw native bytes → original task and financial identity joins → current-source custody admission → child allocation request. The missing owned boundary is typed admission of an unindexed historical observation into an already-progressed current ledger.

The compressed record's SHA256 f5cad35dd378874eefd3657cc09648eba226c66e70a9020f3c814acb94a839d5 matches the tracked PR1699 manifest. Its raw SHA256 is 7007f539aae75b4ccd995264ffc746e2ff0729ad5ddb67ab6747e777d9e27b7d. The archived coordinator snapshots genuinely lack an importable row; their absence is retained, not repaired by inventing one.

Old/current task behavior, money, mode, prompt and timeout match. The current contract only adds three provider-inventory success assertions, expecting 1/1/0; the archived native snapshot reports 3/3/0. Those current assertions therefore remain UNVERIFIED. The legacy exact task comparator, success/skip validators and exception predicate closure remain unchanged.

Archive searches covered literal historical custody admission errors and behavioral unindexed-native/no-remint transfer terms. The November 8 fresh-cycle and independent-ledger transfer cases are relatives: both require an actual donor ledger and a fresh target. This incident has neither and must preserve the progressed target, so their strict import paths remain intact.

## Solution

The proposed extension uses the existing coordinator, custody adapter and registered structural suite. Separate prepare/record actions authenticate the exact original bytes and joins, the narrowly enumerated assertion-only task change and unchanged predicate closure. Preparation binds the complete before-state digest and current source/plan/environment/input fingerprints. Recording re-reads the proof and appends a newly timestamped historical observation without changing any old state field or occurrence.

The canonical record has a distinct kind and false execution, assertion, release, refund, cleanup and stability credits. Only after canonical validation does the adapter project the existing strict no-retry transport shape for downstream consumers. The compiled exact task authority preserves the obligation if the new mutable collection is erased. Missing, mixed, stale or changed authority refuses allocation. Every peer remains selected.

Independent review of the first candidate found a same-case conflict that could be rejected only after publication. The repair must refuse that valid pre-existing qualification before writing, while allowing unrelated custody. Original candidate, failure and review receipts remain retained. The final source patch is170362e42b4a4c8dfc25b2e8dbca5b15afb2653529109515830f26dce4d87f99. Independent CODE_ONLY review2b9a720cadb98651c792ea8e572b70f255cb1d5cb4a64810f4915683dd795146 accepts its exact bytes. The final private full module passes412 tests in220.447 seconds, with source hashes unchanged. Shared validation remains separate.

This is bounded deploy metadata work. It creates no per-agent runtime service, financial mutation, provider query, background polling or additional production channel.

## Open scope

The private owning causal pair and regression evidence are separate from actual current-ledger admission and native gate outcomes. The real prepare attempt correctly refused retained smoke ownership. Existing exact-owner reconciliation must complete before recording; no quiescence check is bypassed. No current occurrence is resolved and no PASS, financial release, refund, cleanup or stability credit is granted by this extension. The exact three files are applied on top of the independent SDK-only35a3cb1 source. Public checks, actual admission and deployment remain pending.

## Human feedback

The standing deploy instruction forbids minting another card, repeated reclaiming or asking the user again after the exact confirmed release stall. The user separately requires the live tests; the historical sandbox warning does not waive production validation or unrelated payment checks.

## Reusable lesson

Provide a typed, append-only admission path for authenticated historical native facts when no donor ledger exists. Preserve original history and current unverified criteria instead of manufacturing a donor, resetting execution state or repeating the prohibited financial action.


## Validation history

The first full run exposed a real regression: a legitimate minimal nonpayment receipt lacks a plan, and unconditional protected-debt discovery dropped its valid PASS. The unchanged existing positive test is the causal RED. The final implementation tolerates missing plans for unrelated receipt discovery and threads the actual protected gate into admission; a protected case without its required plan still refuses. A dedicated negative accompanies the unchanged positive. The final full412-test run passes.

Earlier full411/412 attempts also retain missing private fixture and physical-layout errors. These were corrected by supplying identical existing fixture bytes and the existing required observer mode, without changing product assertions or guards. The parent restored only the matching public observer from0600 to its already-required0644, preserving its source SHA. No unrelated mode or protected instruction changed. Historical candidate/review failures remain in the private evidence.

The final private proof is `implementation/full-module-final-state.json` and its corresponding log under `.context/agentcard-stability/no-remint-protocol-gap-20261111/`. The new tests remain in the existing deploy-test-cycle structural gate. Full-suite success proves the coordinator boundary, not a native payment outcome, actual ledger admission or financial recovery.
