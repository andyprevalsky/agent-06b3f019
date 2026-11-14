---
id: 2026-11-08-semantic-lane-collected-benchmark-only-render-check
date: 2026-11-08
title: Normal semantic discovery collected a finished-run benchmark without its root
surface: harness
component: semantic-test-selection
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/playwright.config.ts broad testMatch included the benchmark-only code-agent render spec
symptoms:
  - semantic-stack native exit 0 but aggregate UNVERIFIED
  - CODE_AGENT_CHECK_ROOT_ID not set (benchmark-only check)
tags:
  - playwright
  - semantic-inventory
  - benchmark-only
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The normal semantic lane reported 61 native cases PASS and one UNVERIFIED after
its UI and latency commands exited zero and the owned stack cleaned up. The
remaining case was deliberately skipped because its finished code-agent root
was absent. It is owned by the dedicated benchmark evaluator, which supplies
that root and requires the exact spec to report one passed test.

Critical path: broad shared Playwright discovery → benchmark-only spec collected
without its root → native skip → strict report adapter → aggregate UNVERIFIED.

## Diagnosis

The adapter correctly refuses to grant assertion credit to a skipped case. Its
classifier was unchanged. Upstream added the dedicated render spec and its
benchmark owner, while broad discovery also added it to normal semantic coverage.
The spec itself explicitly documents the root requirement and ordinary skip.

A permanent collection-only regression failed on the original shared config:
ordinary discovery still contained code-agent-render-check.spec.ts. After the
repair the identical shell suite passed. The regression checks absent, empty,
whitespace and supplied collection context; it never executes hooks or a test
body. Its synthetic collection marker is not a real root or render proof.

Separately, real native adapter discovery compared against the preserved failed
inventory changed from 62 to 61 keys. The only removed key was this exact
benchmark-only spec; no other key was added or removed. Named list-only discovery
with an authentic recorded, already released Claude Code benchmark root still
collected the spec. No old run was resumed and no browser or provider was called.
The dedicated benchmark's actual render verdict remains its existing owner's
responsibility. The original 61 PASS / one UNVERIFIED receipt is immutable, not
retroactively promoted; normal validation must rerun on the committed repair.

## Solution

Use shared Playwright testIgnore for only the exact benchmark-only file when
CODE_AGENT_CHECK_ROOT_ID is absent or whitespace. Supplied context retains its
selection. Native --list and execution consume the same config. Preserve the
spec, benchmark task, evaluator, all timeouts, and the adapter's refusal of
arbitrary skipped or incomplete cases. All 11 adapter regression tests passed,
including that refusal. The supervised shell suite was quiescent without orphans,
remaining children, TERM or KILL.

## Human feedback

Finish the whole-devbox release and normal phone/Google acceptance. Do not grant
credit for unexecuted cases or substitute benchmark outcomes for physical
acceptance. Preserve Freedom, original results, phone state and production env.

## Reusable lesson

Context-dependent benchmark checks need an explicit shared collection boundary;
a strict result adapter must not turn their native skip into assertion credit.
