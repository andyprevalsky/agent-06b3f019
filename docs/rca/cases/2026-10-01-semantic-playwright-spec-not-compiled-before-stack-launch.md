---
id: 2026-10-01-semantic-playwright-spec-not-compiled-before-stack-launch
date: 2026-10-01
title: Semantic Playwright spec had duplicate declarations after branch merge
surface: harness
component: front-end/tests-e2e/chat-lifecycle-latency.spec.ts
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/chat-lifecycle-latency.spec.ts declared PATH_TEST_TIMEOUT_MS twice
symptoms:
  - "Identifier 'PATH_TEST_TIMEOUT_MS' has already been declared. (48:6)"
  - 'Listing tests: Total: 0 tests in 0 files'
tags:
  - semantic
  - playwright
  - deploy
  - spec-load
sources:
  - PR #1344
  - commit b83a62b28eca42e0293b05c0a044fae066299c08
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The local `/deploy` semantic gate stopped while loading tests, before opening a
browser. Playwright reported `Identifier 'PATH_TEST_TIMEOUT_MS' has already been
declared. (48:6)` in
`.context/deploy-runs/20261002-000459-3385/logs/semantic-20261002-004850-83225.log`.
The separate `npx playwright test --list` reproduction reported the same error
and `Total: 0 tests in 0 files`.
The preceding frontend coverage and type checks passed, so the first gate that
parsed the Playwright specs was the expensive semantic phase after stack startup.

## Diagnosis

Critical path: `/deploy` early static and coverage checks omitted E2E spec
loading → a branch edit added a 300-second `PATH_TEST_TIMEOUT_MS` declaration
→ main independently added a derived declaration with the same name → the merge
retained both → Playwright's module loader rejected the spec before any test
could run. `git blame -L 23,51` points to branch commit `029a1cafd2` and main
commit `02fa0e297d` for the two declarations. The first bad code boundary was
the duplicated declaration. The deeper owned cause was the missing E2E spec
parse in the early deploy gates.

The exact local reproduction was `cd front-end && npx playwright test --list`.
It exited 1 with the declaration error and zero tests before the fix. Archive
searches for `Identifier PATH_TEST_TIMEOUT_MS has already been declared
chat-lifecycle-latency` and `semantic Playwright parse duplicate constant merge`
found semantic runner and browser-test cases, but no prior duplicate-declaration
case. This is a new compile-coverage gap, not a recurrence of those cases.

## Solution

Removed the branch's redundant 300-second declaration, retaining main's derived
timeout and leaving the five-second per-sample ratchet intact. Added a Playwright
`test --list` preflight to `scripts/tests/semantic-deploy-gate.test.sh`, which
`/deploy` runs in its early command-structural group. It parses every E2E spec
without opening a browser, catching duplicate declarations and other spec-load
errors before starting services.

The identical `cd front-end && npx playwright test --list` command now exits 0
and lists 13 tests in seven files. The semantic deploy structural test also
passes. To verify the permanent guard, I restored the buggy spec from commit
`b83a62b28eca42e0293b05c0a044fae066299c08` and ran
`bash scripts/tests/semantic-deploy-gate.test.sh`: it exited 1 on the duplicate
declaration with `FAIL: semantic specs must load before browser tests start`
(`.context/semantic-gate-red.log`). Restoring the fixed spec and rerunning the
same command exited 0 (`.context/semantic-gate-green.log`). The full local
semantic UI suite passed 8/8, and the separate lifecycle latency ratchet passed
5/5 paths. No product runtime or agent hot path changed; the preflight runs once
per deploy and its cost scales with the number of checked-in test specs rather
than the number of active agents.

## Human feedback

None recorded.

## Reusable lesson

Parse every Playwright spec in the early deploy gate so merge-time syntax errors fail before browser-stack startup.
