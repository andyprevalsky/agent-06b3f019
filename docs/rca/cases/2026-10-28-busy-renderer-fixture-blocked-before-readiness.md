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
  - recovery_storage_capture_carries_cookies_when_frames_busy
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
  - commit 27c2559b99565d7b038ee854d827933947a9e0a6
  - plan:.context/deploy-fresh-20261027/rca-storage-capture-busy-ready-7947/manifest.json
  - plan:.context/deploy-fresh-20261027/main-sync8-readonly/native-plan/browser-tilion-owner/receipt.json
repro: agents/tests/blackbox/browser_tilion.blackbox.py
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

### Recurrence: busy storage-capture sibling added without the readiness barrier

The fresh full agents gate on440d reported
recovery_storage_capture_carries_cookies_when_frames_busy failing at the
original10,000ms document-title wait, before storage capture ran. The
browser-tilion domain took301.498s across its full case set. The original
aggregate retained122 passing domains, native exit1 and outer exit143;
the cause of outer143 is unknown.

The earlier fix above covered the classifier fixture. This distinct storage
fixture used the same unsafe ordering: parent and child page scripts scheduled
60s busy loops300ms after load, before the remote test confirmed readiness.
That sibling bypassed the existing readiness-barrier pattern. Literal searches
for the storage test name found no separate case; behavioral searches for
busy renderer, storage capture and title readiness found this case. Its
Solution and unchanged Human feedback were read before extending the fix.

The same local Chromium/fake-Tilion driver introduces a controlled400ms pause
after DOMContentLoaded and selects only the original or candidate module:

    agents/venv/bin/python .context/deploy-fresh-20261027/rca-storage-capture-busy-ready-7947/driver.py original
    agents/venv/bin/python .context/deploy-fresh-20261027/rca-storage-capture-busy-ready-7947/driver.py candidate

Original: the same title-timeout failure in16.028s. Final candidate: pass
in12.907s. The400ms interval is a causal scheduling control, not a measured
delay in the historical failing run. Both snapshots retain the same owning
test and driver; the final argument only selects its frozen source bytes.

The candidate verifies the original title predicate and the child handler's
readiness before arming the parent loop and sending the child's start message.
A local HTTP beacon observes the first blocked renderer entry outside that
renderer. Both loops are armed; no claim is made that two loops execute
simultaneously. Frames sharing a renderer serialize their work. An initial
variant that waited for two entry beacons failed and is retained as rejected.
A first-entry-only prototype passed but was superseded by the final explicit
child-readiness check.

All353 assertion ASTs in the original merged module are identical. Preserve
the original10s title wait,60s busy work,1s post-entry pause,6s configured
storage bound,20s outer await and7.5s elapsed assertion. The added child
readiness and local-beacon setup waits are each bounded10s. The final native
log reports live cookie source, one cookie, empty origins and the unchanged
6.0s capture timeout; it exercises the real bounded capture rather than
injecting a result.

Exact patch SHA:
c8e1806bb5ccb5ced057cc9492c94f5dd8c5453363f2b2f9694f71b9a09d6394.
Final module SHA:
2d159ecc0acec65a9ff11a59e09adf07dc6b4aad0a77c130d422cc40cb3cd073.
Independent review was GROUNDED, report SHA:
8c286dd230e2e775b212e4cd6629ecb48e5774973681c7cf87ee550e98abc66d.

The fixture-only correction is committed in27c2559b. Root then ran the entire
canonical browser-tilion owner under branch coverage, with no case filtering.
The child command remained coverage run --parallel-mode
scripts/run_blackbox_tests.py browser-tilion. All merged cases passed in
171.195s; owner67556 exited0 and was joined. Explicit composition combined
the122 passing original domain chunks with this fresh full owner, then ran
214 cache tests and173 unit tests. All four commands exited0 and the native
coverage report was85% against80%. The original failed aggregate remains
failed and is not described as a new complete-suite pass.

The focused original and final candidate each recorded six known child birth
identities; all were gone on completion and native commands were joined.
This is the recorded inventory, not a separately complete census of every
later child. No provider, model, DB or financial request was used in the
controlled proof. No production storage-capture implementation changed.
The coordinator required original assertions and bounds and distinguished the
fixture from actual payment hydration. This does not prove the unrelated
900s payment failure, tunnel cause or later storage wait fixed.

## Human feedback

None recorded for this fixture. The user requested completing the existing deployment; no timeout or assertion waiver was requested or inferred.

## Reusable lesson

Confirm renderer readiness before arming intentional blocking work and observe entry from outside that renderer.
