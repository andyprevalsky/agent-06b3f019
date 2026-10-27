---
id: 2026-10-27-frozen-light-markup-read-before-canvas-sizing
date: 2026-10-27
title: Frozen light markup assertion sampled lazy canvases before passive sizing
surface: harness
component: rose-theme-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Container-presence wait resolved before useCanvasSizing assigned the three canvas dimensions required by the frozen light fixture
status: open
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
