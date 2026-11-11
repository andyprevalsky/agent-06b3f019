---
id: 2026-11-09-cleanup-renewal-compared-historical-contract-to-selection-metadata
date: 2026-11-09
title: Native cleanup renewal compared a historical execution contract to current selection metadata
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: clean_isolated_successor compared a completed historical gate digest with the new plan's whole gate object
symptoms:
  - "native cleanup proof refused: native cleanup: successor contract"
  - Fresh full cloud validation refused despite unchanged execution checks and released successor ownership
  - "historical witness requires complete successor after a pre-admission source refusal"
  - "focused command omits an unresolved failing check after an authorized deploy-only omission"
tags:
  - deploy
  - cleanup
  - evidence
  - custody
sources:
  - PR #1905
  - commit af356053db6c91725b4f499b3cff78a4cbb75154
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_clean_successor_renewal_binds_historical_gate_for_selection_metadata_only
status: open
---

## Problem

After the SDK repair legitimately added a Dockerfile selection reason, native cleanup renewal refused before fresh validation. The completed historical successor retained six PASS and seven FAIL, native exit 1, complete execution and verified cleanup. Its execution command, thirteen ordered checks, environment and worker contract matched the current gate; the explanatory selection metadata differed. Original incomplete canary obligations and failed outcomes were still preserved and could not be reset or relabelled.

## Diagnosis

The existing validator compared the historical receipt's whole gate digest to the current plan's whole gate object. Independent read-only replay reproduced the exact refusal. Substituting the authentic historical gate only in memory let the unchanged remaining validator accept; that causal control was not used as a canonical workaround.

An independently authenticated private archive recovery supplied the exact historical admission snapshot. Its state identity matched the successor request's recorded seal. Its plan digest, source, environment, gate contract and input fingerprint matched the original native request and receipt. Independent Git-object reconstruction also matched both historical and current source/input digests. Current source inputs legitimately differ, so historical task PASS cannot certify current acceptance.

## Solution

Keep the current generated plan and original cleanup proof intact. Accept an optional separate typed historical-successor witness during isolated source renewal. It identifies the exact successor receipt and a hash-bound recovered admission snapshot. Verify the snapshot's native admission seal, plan and source, then all three recorded execution-binding fields. Require exact keysets and type-preserving canonical equality for every gate field except the explicit string-list selection explanation. Altered checks, commands, environment, workers, unknown fields or boolean types still refuse.

The original proof can still renew only its validation source. Record supplemental witness evidence separately, preserve all original native bytes, grades, clocks, exclusions and false cleanup/credit flags, and grant launch authority only. Existing strict successor collection, publisher quiescence, native evidence hashes, original proof replay, source and quiescence checks remain required. Fresh full current-source execution and normal publisher acceptance remain mandatory.

## November 11 recurrence: authenticated historical inputs and future omissions

A later source transition exposed three further distinctions. The user explicitly excluded the mass test from all future deploys while preserving manual benchmark eligibility and historical failures. The current native inventory therefore dropped that one case. A compatible independently owned immutable source also changed current environment inputs. The historical request's backend runtime hash differed from current configuration.

During the transition, the custody guard refused before UUID generation, request creation or native adapter launch. Its six-field FAIL/UNVERIFIED row remained the latest smoke coverage, inside a stale attempt whose three sibling workers completed. It was not an incomplete native execution. Renewal now recognizes only that exact path: authenticated terminal sibling request/result/receipt bindings, no ownership or process flags, one enclosing namespace, and no smoke request namespace. Unknown, token-bearing, partial or owned execution still refuses. The immediate historical native predecessor must still pass all original validation.

The typed historical witness continues to bind the exact original gate, environment and input fingerprint. An ordered current subset is allowed only through the existing catalog-approved deploy omission helper; all other execution fields remain identical. Historical runtime hashes must reproduce the sealed native input fingerprint using the existing Git input reconstruction. Current source, plan, environment, runtime and fingerprint bindings are validated independently. No old environment is restored, no historical secret is reconstructed, and no old native outcome supplies current acceptance.

Canonical renewal on source `3a177851` exited zero while changing only the original proof's validation source. Its 567 file bindings, 13 participants, 14 exclusions, false cleanup/credit and historical financial no-retry authority remained unchanged. Five permanent regressions reproduced the owning refusals on the original runtime and passed unchanged after repair; the full existing suite passed 455 tests. The actual copied public replay was idempotent with 1,021 canonical/native inputs unchanged. These are launch-authority proofs, not current test or financial credit.

The focused planner separately still demanded the historical mass failure after the current inventory had legitimately omitted it. It now uses the same catalog authority for historical required checks absent from current selection. Every currently selected failing check remains mandatory. The existing regression reproduces the old refusal, rejects ordinary failure-quarantine as an omission, and preserves failure history. All 455 owning tests pass. The mass task's prompt, evaluators and manual eligibility are unchanged; omission is never PASS.

The prior frozen `9718c6e` full semantic run passed all 57 UI and five latency units without skips or flaky UI outcomes, and its structural/controller workers completed with verified cleanup. New combined-source full gates, a fresh unchanged native chat run and the normal full evidence publisher remain required before deployment. Original failures, missing capture context and clocks remain preserved.

## Verification and limits

The actual native admission failure and its exact error are retained privately. The new existing-suite regression failed before the interface/validator repair and passes afterward, including missing/foreign witness, receipt and snapshot tampering, changed execution fields, removed checks, source/input/environment/plan tampering and repeated renewal controls. All 407 tests in the existing deploy-cycle owning suite pass. Independent candidate replay against authentic original native artifacts accepts the recovered historical witness while preserving the current gate and state copy.

Canonical renewal on the frozen repaired source, fresh full thirteen-task validation, normal chat evidence publication and deployment remain pending. No old task failure becomes PASS, no missing original payload is reconstructed, and no provider exception or cleanup completion is inferred from this launch-only proof.

## Related cases

The November 3 native campaign reconciliation case separates authentic historical release from recovery. The structural selection-digest case likewise distinguishes admission history from a new explanation. This recurrence binds historical inputs to the actual native request rather than discarding contract authority.

## Human feedback

The assignment forbids fabricated history, weakened publisher assertions, hidden state resets and obsolete-source acceptance. Those constraints require authenticated historical authority plus fresh current-source execution.

## Reusable lesson

Validate a historical execution against its sealed admission inputs. A changed selection explanation neither invalidates authentic old cleanup nor supplies acceptance for changed source.
