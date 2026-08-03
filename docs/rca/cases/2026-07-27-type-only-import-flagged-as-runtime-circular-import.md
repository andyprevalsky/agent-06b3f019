---
id: 2026-07-27-type-only-import-flagged-as-runtime-circular-import
date: 2026-07-27
title: The structural checker reported CIRCULAR IMPORT on type-only imports that TypeScript erases
surface: mac-app
component: structural-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: mac-app structural cycle detection — walked all import statements including type-only ones
symptoms:
  - "CIRCULAR IMPORT reported on blink/v8-deserializer"
  - structural checker red on an import pair that cannot exist at runtime
tags:
  - mac-app
  - structural-tests
  - typescript
  - false-positive
  - circular-import
sources:
  - commit 88d0c0246
repro: none-recorded
status: fixed
---

## Problem

The mac-app structural checker reported `CIRCULAR IMPORT` for `blink/v8-deserializer`
— a cycle that cannot exist at runtime, because the edge that closed it was a
type-only import.

## Diagnosis

Cycle detection walked every import statement, including `import type` edges.
TypeScript erases type-only imports at compile time, so such an edge produces no
runtime module dependency and therefore cannot form a runtime cycle. The checker's
model of "import" diverged from the runtime semantics it was supposed to police,
making it fail on correct code.

## Solution

Cycle detection now walks **runtime** imports only. Verified it still catches real
value cycles via an injected pair, plus a negative control.

## Human feedback

None recorded.

## Reusable lesson

A structural invariant about runtime behavior must be computed from runtime-visible
edges only — count `import type` as no edge, or the checker will red-flag legal code.
