---
id: 2026-10-27-frozen-light-markup-read-before-canvas-sizing
date: 2026-10-27
title: Frozen light markup assertion sampled lazy canvases before passive sizing
surface: harness
component: rose-theme-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Container-presence wait resolved before useCanvasSizing assigned the three canvas dimensions required by the frozen light fixture
status: fixed
symptoms:
  - "desktop background renders the stock markup byte-for-byte"
  - "Frozen desktop markup differs by six missing canvas width/height attributes"
tags:
  - canvas
  - readiness
  - test-fixture
sources:
  - commit e8e8cff1f26e97aceb8ea87740a0e775e13c1c9a
  - plan:.context/deploy-fresh-20261027/rca-rose-theme/REPORT.md
repro: front-end/src/tests/blackbox/rose-theme.blackbox.tsx
---

## Problem

The first rose-theme case failed byte equality; the retained actual DOM lacks only width1440/height900 on three canvases. No other fragment differs.

## Diagnosis

The lazily mounted renderer's container is visible before its passive sizing callback. The test treated that earlier event as completion of the initialized markup contract. A controlled100ms deferral of the real first sizing callback reproduces the exact missing attributes; the unchanged full37-case file returns36PASS/1FAIL.

## Solution

Applied reviewed test-only change awaits the original exact frozen-markup assertion with its existing15000ms wait and20000ms outer bound. Same native command and controlled sizing schedule pass37/37. A never-sized negative still fails byte equality after15.18s. All135 original expect-call ASTs remain. No frozen fixture, production renderer or sizing hook changes.

## Coordinator constraints

Preserve exact frozen bytes, all light/dark contracts and deadlines; do not regenerate snapshots, strip attributes or claim a baseline pass as repair. Shared source, archive/index and full combined acceptance belong to the coordinator.

## Evidence and limits

REPORT.md, native-summary.json, native-observations.jsonl and assertion-and-source-receipt.json beside this draft contain native commands, exact DOM delta and hashes. Original scheduler timing is not reconstructed; the payload boundary is matched by a controlled native schedule. Status remains open pending application and owning full-coverage acceptance.

## Human feedback

No additional user feedback was recorded for this fixture. The coordinator retained the exact frozen bytes and bounded negative control.

## Reusable lesson

Wait for the initialized markup contract itself when container mounting precedes passive initialization; preserve every expected byte and the existing timeout.

## Second readiness boundary observed in full coverage

At af4cde045 the complete frontend gate passed3823 tests and failed the same desktop case after15950ms. This actual payload differs from the earlier missing six canvas attributes: the entire575-byte three-canvas renderer div is absent. Actual received markup66833bytes/hash5191a74f002a24a92ad286fc74c171138f7fc5bf52e972506042ccf2230217e1 equals the controlled cold-module red byte-for-byte; all other expected bytes match. The first correction remains necessary but is insufficient for this second fixture phase.

A17s transformation delay of the same real lazy renderer reproduces that exact payload and original15s byte-equality failure. Loading that real renderer alongside fixture dependencies at collection gives identical focused-command1/1 and owning-file37/37 green. It adds no mock and does not mount the component: the first equality callback still has zero canvases, followed by real lazy resolution and passive sizing. The never-sized negative still fails after15366.876ms with six null dimensions. All135 expects, frozen bytes,15000ms readiness and20000ms outer bound remain. This is a rendered-markup contract, not a production cold-module loading SLA.

The coordinator applied the exact one-import patcha2dcdc609000d7d4b5c62b226a946e1099fb1f4930e230b3d3a9fdb4ed70860b after independent review and actual-payload match. Keep the existing registered strict desktop assertion as the regression; no source-mirroring assertion or permanent17s delay is needed. Native evidence and accepted scope are in plan:.context/deploy-fresh-20261027/rca-rose-theme-recurrence/payload-followup/FOLLOWUP.md and plan:.context/rose-theme-conditional-review-20261027/REVIEW.md. Actual historical module/scheduler duration remains unrecorded. This fixed status covers the reproduced fixture boundaries; combined full-source acceptance and deployment remain separate gates.

## October28 related Privacy route fixture boundary

On b3364256, app-wiring's Privacy case failed its original5000ms wait at line68 with only the route-loading Suspense fallback present; the heading assertion was not reached. A6500ms transform delay of the same real Privacy module reproduces that exact assertion/payload in5173.807ms. Resolving that real module with test dependencies at collection makes the identical focused command pass648.872ms; the route still first mounts Loading before the real heading. A wrong-real-Terms-page control still fails the original Privacy heading assertion. All24 owning cases pass, all79 expect ASTs and5000/30000ms bounds remain unchanged. This adds no production mock or production loading guarantee.

The one-import patch3916f82d25ea4c6e96b457d32eda3cb62dea91a90aa1dfc29dfe409fb468a157 received independent GROUNDED review and was applied by the coordinator. Exact commands, rejected mis-cwd launch, payloads and process cleanup are in plan:.context/deploy-fresh-20261027/rca-app-wiring-privacy-batch12/controlled/CONTROLLED-REPORT.md. Historical transform duration remains unrecorded; full coverage acceptance is a separate coordinator gate.

The next full coverage run passed Privacy but exposed the same fixture boundary on ResearchBlogPost: line105's unchanged Loading-absence assertion failed before the not-found heading assertion. Preparing just one page was incomplete for this route-table fixture. Exact patch0e4c9940004f5034585832212631f20b07616a67e58c5db7be4a4229339f3315 resolves all14 distinct real lazy targets declared by ROUTE_TABLE during collection, including the conditional mobile preview, with no extra targets or production changes. Independent review verifies all79 expectations,24 cases,5000/30000ms bounds and all non-import statements unchanged.

A6500ms delay of the real Research module produces the same Loading predicate failure in5477.964ms; the identical focused command with the common setup passes561.683ms. The candidate still begins with empty DOM then Loading, and a real wrong-page negative still fails. All24 owning cases pass. The actual full-run failure matches the predicate boundary, not the entire prior-page SEO head or a reconstructed historical transform duration. Matched receipts, exact commands and cleanup: plan:.context/deploy-fresh-20261027/rca-app-wiring-privacy-batch12/all-route-batch13/MATCHED-REPORT.md. Full V8 coverage acceptance remains a separate gate.
