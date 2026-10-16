---
id: 2026-10-16-cold-bootstrap-prefetched-before-empty-check
date: 2026-10-16
title: Boot prefetch populated the cold driver's mandatory empty checkout
surface: infra
component: cloudbench-cold-source-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-boot.sh prefetched a cold checkout before cloudbench-run.sh performed its first-empty-checkout validation
symptoms:
  - "FATAL: cold-primary first checkout requires an exact ref and absent or empty unlinked destination"
  - "FATAL: could not bootstrap requested ref on fresh storage"
  - "cloudbench result rejected: run artifact tasks must be a list"
tags:
  - cloudbench
  - cold-primary
  - staged-boot
  - bootstrap
sources:
  - PR #1525
  - fleet run 20261016-073424-17031
  - commit 6eea8703a81abe08989ab65657eeedf627da6b33
  - commit bcb06298c7c5d2820330ec4761e424a2e7229eed
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py ColdBootstrapSingleOwnerTests
status: fixed
---

## Problem

Both actual N2 guests fetched and verified the requested bcb task commit, then
failed before the stack barrier or any benchmark result. Full collected guest
logs contain the exact empty-destination refusal followed by exit 1 and a cleanup
ACK. The controller's earlier tailed log omitted the checkout and refusal lines;
its downstream missing-task-list error was not the first bad boundary.

The complete originals remain in the root-owned continuation packet
`snapshot-canary-4170811507acebf430096217d94cff74/remote-logs-1792137198080389127.private.json`.
Each decoded driver log is 1,964 bytes. Fetch took 157/165 seconds and checkout
124 seconds. Those durations are observations, not evidence that a timeout caused
this failure. Both Machines were subsequently observed stopped by the root.
This report does not certify their release to the pool.

## Diagnosis

The executed path was staged launch -> immutable boot supervisor -> bootstrap
fetch -> immutable driver -> cold first-checkout guard -> terminal artifact
collection. Boot called the fetch helper on the empty destination, which created
and verified the requested checkout. The driver then called the same helper
with `CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT=1`. The correctly strict guard rejected
what boot had just populated. Two layers both claimed ownership of first
initialization; this is the deepest demonstrated contract conflict.

The registered reproduction extracts the actual boot bootstrap block and both
actual driver fetch blocks, invokes the unchanged fetch helper against a tiny
local Git origin, and preserves the exact empty-destination assertion. Before
the fix the fresh-cold case fails with the same refusal after verified checkout;
the warm, populated-cold refusal, and symlink-cold refusal controls pass. The
same four cases pass five consecutive unchanged runs after the fix. The existing
fetch-helper regression also passes. No provider or guest calls occurred.

Archive searches were `git-fetch bootstrap-checkout no report-card` and
`fetch ref checkout exit bootstrap`. The related case
`2026-10-06-fresh-source-fetch-downloaded-unneeded-history` addresses unnecessary
history, not this two-owner initialization conflict. Its history optimization
did not remove the duplicate bootstrap. This is a related boundary rather than
a proven recurrence of that cause.

Reference review: OpenClaw `test/scripts/ci-linux-git.test.ts:551` asserts one
init/remote/fetch/checkout/verify sequence. Codex
`codex-rs/skills/src/assets/samples/skill-installer/scripts/install-skill-from-github.py:131`
owns checkout within one installation routine. Claude Code
`src/utils/plugins/pluginLoader.ts:578` owns requested-commit fetch after clone;
Hermes `hermes_cli/worktree_ops.py:390` owns its worktree materialization call.
These are ownership analogues, not implementations of this boot protocol, and
none justifies weakening an empty-destination requirement.

## Solution

Skip only the redundant boot-supervisor prefetch when the explicit cold-primary
flag is 1. The injected driver then owns the original strict empty check and
initial checkout; its subsequent normal synchronization verifies the same ref.
Warm boot retains the existing prefetch path. The fetch helper, source/ref
checks, startup deadlines, runtime evidence and result validators are unchanged.

This deletes the conflicting cold-path action instead of adding a receipt,
exception, retry or permissive guard. It prevents the same conflict for every
cold primary task using this supervisor/driver pair. It does not accelerate the
necessary fetch or checkout, and does not modify a running controller.

Local causal proof initially established the code fix only. The native
verification below subsequently supplied the probe/task outcome, cleanup and
reuse evidence. REAL600 remains pending.

## Human feedback

Root required the first failing bootstrap boundary, the full retained guest
log, and an actual boot-to-driver contract test. It explicitly prohibited a fix
to the downstream result validator, native calls in this lane, active-source
mutation, timeout increases or fabricated successful return evidence.

## Reusable lesson

Give one layer ownership of first initialization before enforcing a strict empty-destination contract.

## Native verification

Root's corrected native attempt 49 passed the first-checkout boundary on both original probe tasks; its later return-audit failure was a separate cause. Attempt 53 then passed the required N2 preflight and completed the real `parallel-tool-calls` task on control source `928e5326c1256d7466395151e2192b231b1cd000`, task ref `570830dbf17635e13d16a6f03b4d705f6b6443b1`. The task passed in 97.6 seconds, and the parent lifecycle ended verified with controller exit 0, immutable runtime return/release evidence and absent claims. Root also confirmed the exact Machines stopped. This closes the duplicate first-checkout defect, not the original600 goal or the extra-worker runtime path.

The local immutable evidence is `real53-artifacts-1792142781475374527/{run.json,report-card.json,qualification.safe.json}` and the lifecycle/release packet `v41-command-605a63d4b33151e5/response.json` in the continuation directory. Run SHA256 is `8f3dc7a0419f8b6c09a862248c18abc95be017e93af60e1f8428f196033f5364`; report SHA256 is `c237f30e73f3dcb3b56d6f355884423b9e88f0c85210d2118ca13b48f916f633`. Previous failed packets remain intact.
