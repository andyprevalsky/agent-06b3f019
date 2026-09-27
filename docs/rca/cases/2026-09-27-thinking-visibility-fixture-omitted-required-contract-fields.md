---
id: 2026-09-27-thinking-visibility-fixture-omitted-required-contract-fields
date: 2026-09-27
title: Thinking visibility fixture omitted required agent and context fields
surface: front-end
component: message-list-thinking-visibility-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: makeAgent and makeContext supplied incomplete objects to the real AgentDetail and AgentContextValue contracts
symptoms:
  - "TS2352 Conversion to type AgentDetail may be a mistake"
  - "TS2739 missing inspectionContext, stagePendingAgentCreation, reconcilePendingAgentCreation, rollbackPendingAgentCreation"
  - "message-list-thinking-visibility.blackbox.tsx(14,10)"
  - "message-list-thinking-visibility.blackbox.tsx(29,3)"
tags:
  - typescript
  - fixture
  - contract-drift
  - thinking-visibility
sources:
  - commit e930a9b162ac3cbc4b172a4d41c93648a1d5e66a
  - PR #1299
repro: front-end/src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx
status: fixed
---

## Problem

An explicit frontend app-project typecheck reported two diagnostics in the
thinking-visibility blackbox fixture: its asserted `AgentDetail` lacked required
fields, and its `AgentContextValue` omitted four required members. These were
static fixture defects; the evidence did not establish a new product behavior
failure. The full diagnostic capture is
`.context/acceptance/proof20-upstream-static-recovery/independent-frontend-app-tsc.log`.

## Diagnosis

Archive searches used `AgentContextValue TS2739 AgentDetail thinking fixture`
and `frontend fixture missing required fields stale context type contract`.
No exact type-contract recurrence was found. The September 18 chat-escalation
case owns the same test file but diagnoses a different runtime boundary;
the September 3 agent-view isolation case changes context contracts but does
not diagnose this fixture. This is a new fixture incident, not a reopening of
those product fixes.

`makeAgent` used `as AgentDetail` around an incomplete object, included the
obsolete agent-level `messages` property, and omitted required counters,
workflow/status metadata, verifier and tools. `makeContext` omitted inspection
and pending-creation members. The fixtures had drifted from the interfaces they
claimed to instantiate; the repair belongs in the fixtures, not weaker types
or changed UI assertions.

The owning compiler replay loads the real `tsconfig.app.json` options, app root
files and ambient declarations, overlays only this fixture's bytes, and requests
diagnostics only for that source file. The unchanged command
`node .context/acceptance/proof20-upstream-static-recovery/check-thinking-fixture.cjs`
returned TS2352 and TS2739 before, and no diagnostics afterward. The receipt
`thinking-fixture-red-green.json` pins both byte streams. An initial reduced
setup omitted the existing jest-dom ambient declarations; its extra matcher
errors are preserved in explicitly invalid logs and excluded from the proof.

The original convenience command `tsc --noEmit` targeted a root configuration
with `files: []` and references. Its exit 0 did not prove application type safety.
The separate explicit project check found 204 diagnostics across 72 files;202
other diagnostics remain outside this bounded repair. Neither the fixture-only
compiler result nor the Vite/Vitest pass is presented as a full-app typecheck.

## Solution

The existing fixture now builds a complete, directly typechecked `AgentDetail`,
removes the assertion cast and obsolete property, and supplies the required
context fields with inert fixture values. Context-level messages remain in
place. Rendering code, both behavioral assertions, and their timeouts are
byte-identical; product runtime code, prompts and evaluators were not changed.

After applying the reviewed candidate, the physical-file compiler and targeted
ESLint passed. The actual unchanged Vitest file passed 2/2 in 3.52s:

```sh
cd front-end
node node_modules/vitest/vitest.mjs run src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx --maxWorkers=3
```

`.context/acceptance/proof20-static-fixed/gates.json` binds the applied file hash,
all three gate exit 0 results and their log hashes. The bounded independent
review is `independent-static-batch-review.json` in the upstream-static-recovery
folder. Existing blackbox assertions remain the behavior regression; the real
TypeScript contract checks the fixture shape without a suppression or cast.
At 10,000 agents the fixture-only change adds no runtime work or state.

## Human feedback

The user limited the work to infrastructure and rejected harness, task,
model, evaluator or timeout changes made to improve scores. This correction
preserves the behavioral assertions and reports the remaining app diagnostics
without claiming a broader pass.

## Reusable lesson

Construct test fixtures against their actual return types instead of asserting incomplete objects into the contract.
