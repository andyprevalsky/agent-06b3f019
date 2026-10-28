---
id: 2026-10-28-busy-renderer-fixture-blocked-before-readiness
date: 2026-10-28
title: Busy-renderer fixture armed blocking JavaScript before remote readiness
surface: agents
component: browser-tilion-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The synthetic page armed its blocking timer at load, before the remote worker could complete the title readiness read
symptoms:
  - Page.wait_for_function: Timeout 10000ms exceeded.
  - classifier_reads_bounded_on_busy_renderer
  - browser-tilion FAIL
tags:
  - tilion
  - playwright
  - readiness
  - fixture-race
sources:
  - commit 940d216341279dd23fda00003b3d774c576c3de4
  - commit 4c118e0de38c3a0c3f3b1dd93d3b30d89d099608
  - PR #1580
  - plan:.context/deploy-fresh-20261027/rca-tilion-busy-readiness/FINAL.json
repro: agents/tests/blackbox/browser_tilion.blackbox.py test_classifier_reads_are_bounded_on_a_busy_renderer
status: fixed
---

## Problem

The full agents gate on940d failed the title readiness wait before entering the classifier assertion. The fixture set its title then scheduled a60000ms renderer block300ms after load. Its remote CDP client could reach the title check after that block began.

## Diagnosis

The recorded original failure is the title wait, not the classifier's bounded reads. A controlled400ms pause after the real local Chromium DOMContentLoaded reproduces that exact10000ms failure in15.554s. The same native driver with corrected fixture passes in9.634s. The historical pause duration was not captured; these controls prove the fixture scheduling defect, not an external provider or production latency cause.

Archive searches covered busy renderer, title readiness and wait_for_function. The semantic networkidle readiness case2026-10-05 is a prerequisite-boundary analogue; the2026-09-30 Kernel title gap has no causal evidence for this occurrence. Both Diagnosis/Solution records were read. No provider or credential failure is established.

## Solution

Confirm the existing title readiness before explicitly arming the unchanged60s busy loop. A local same-origin beacon marks entry outside the blocked renderer. The existing1s pause,1.5s read budget,20s outer limit and4.5s elapsed predicate remain unchanged. All322 original assertion ASTs are identical. The registered browser-tilion domain always executes this regression under agents coverage.

Replacing only bounded classifier capture with an unbounded real title read makes the same corrected fixture fail its20s outer limit (26.567s overall), proving the renderer is actually blocked. Original/final/negative known child births are gone and commands joined. A failed console-event prototype is retained as superseded and was never applied. Evidence and exact hashes are in the source receipt above. These were real local Chromium/fake-gateway controls, with no funded browser, model or DB call. Full deployment outcomes are recorded separately; no historical scheduler timing is inferred.

Golden review: not applicable (no approval-gated hunk); independent review preserves all original assertions and confirms the real blocked-renderer negative.

## Human feedback

None recorded for this fixture. The user requested completing the existing deployment; no timeout or assertion waiver was requested or inferred.

## Reusable lesson

Confirm renderer readiness before arming intentional blocking work and observe entry from outside that renderer.
