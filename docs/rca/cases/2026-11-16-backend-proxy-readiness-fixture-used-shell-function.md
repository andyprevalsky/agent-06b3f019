---
id: 2026-11-16-backend-proxy-readiness-fixture-used-shell-function
date: 2026-11-16
title: Backend proxy readiness fixture could not be invoked through exec
surface: harness
component: cloudbench-dependency-sync-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The backend readiness fixture supplied a shell function to the production launcher that executes flyctl
symptoms:
  - exec flyctl not found
  - backend data-plane proxy did not become ready within 4s
  - test_backend_data_plane_proxy_keeps_process_readiness_contract
tags:
  - test-fixture
  - proxy
sources:
  - commit 90896a3ecee1b1f462ea9f0f373d93ed8c30158e
  - agent ae063f2bff50ecfd8
repro: python3 -m pytest -q -p no:cacheprovider agents/benchmarks/cloudbench_dependency_sync_test.py -k test_backend_data_plane_proxy_keeps_process_readiness_contract
status: fixed
---

## Problem

While validating the lane-ceiling capacity deferral, the existing backend proxy
readiness case failed before reaching its assertions. The proxy log reported
`exec: flyctl: not found`; the bounded four-second readiness wait ended with
exit 97 because no attempt file existed.

## Diagnosis

The production helper deliberately executes the proxy binary in its background
child so the recorded PID identifies the native process. The test supplied a
Bash function named flyctl. Bash exec cannot execute a shell function, so the
fixture never launched. This is a test boundary mismatch, not evidence of a
production readiness failure or a lane-capacity failure.

Archive searches for `exec flyctl shell function` and `lane ceiling capacity
deferral` found the related October 31 extracted-recovery fixture case. Its
lesson applies: use an executable double at a native exec boundary. No runtime
change or broader benchmark acceptance claim follows from this test repair.

## Solution

Replace the shell function with a private executable flyctl on the fixture's
PATH. It records the same attempt and stays alive until the existing cleanup
terminates it. Keep the original one-attempt assertion, live-PID assertion,
process-readiness behavior, four-second readiness budget and ten-second outer
subprocess timeout. Golden reference: not applicable; no approval-gated hunk.

## Validation

The command in `repro` failed on the original committed source with exit 1 and
`exec: flyctl: not found`. The repaired fixture passed five consecutive runs,
with every assertion and deadline unchanged. One intermediate repair omitted
the ATTEMPTS shell variable; that failed attempt is preserved in the local
validation receipts and was corrected before the five passing runs.

The separate lane-capacity regressions have six complete shard-4 receipts,
each exit 0 with 31 PASS lines including scenario 4b, plus five prior focused
repetitions in the native transcript. Those prove capacity deferral, not browser
experiment performance. Full /push qualification remains separate; a duplicate
quarantine key arriving from latest main blocks the agents coverage gate.

### Shard assertion visibility follow-up

The prior six shard-4 logs and a fresh run returned exit 0 with 31 PASS lines,
but each also reported `assert_pool_provisioning_refused: command not found`
for scenarios 12 and 13. That helper was defined inside the shard-1 scenario,
so shard 4 skipped its definition. Those receipts still prove scenario 4b,
but do not prove the missing assertions ran. Move the unchanged helper above
the first scenario guard so every shard sees it; keep all assertion bodies,
scenario ordering, controller deadlines and acceptance rules unchanged.
A complete corrected shard-4 rerun is required before claiming the gate passes.

The workflow and span-history diagnostics pass with the original external
TMPDIR. The earlier failures used a TMPDIR inside the Git worktree: span
history detected Git and selected branch-segment behavior; the Temporal test
server had no existing cache there. Preserve those failures as environment
misconfiguration evidence, not source regressions. The duplicate catalog key
on origin/main remains a separate full-coverage blocker.

### Catalog serialization repair

Parent independently reviewed and authorized removing the overwritten first
quarantine key on browser-biometrics-webdecoy. Ordinary JSON parsing before
and after is byte-for-byte equivalent after canonical serialization of all
tasks; prompts, evaluators, timeouts, criteria and effective quarantine remain
unchanged. Git history and the private catalog-semantics receipt retain both
incident records. Extend the existing duplicate-key regression to parse the
actual checked-in normal and Polar catalogs strictly, in addition to its
synthetic negative control. The previously failing auth-test-site-benchmark
domain now passes (6.5 seconds); full agents coverage is rerunning.

## Reusable lesson

Extracted shell fixtures must supply an executable at an exec boundary, so
process identity and cleanup remain representative of production. A same-name
shell function is not an equivalent substitute.

## Human feedback

Work only in the existing isolated ceiling-fix worktree. Preserve benchmark
definitions, assertions and timeouts; do not add agents or alter other worktrees.
