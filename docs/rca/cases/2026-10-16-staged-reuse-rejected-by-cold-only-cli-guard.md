---
id: 2026-10-16-staged-reuse-rejected-by-cold-only-cli-guard
date: 2026-10-16
title: Staged launch rejected the existing reset policy after a verified return
surface: harness
component: run-bench-cloud staged transport selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: staged transport selection required the per-resource first-empty-checkout flag even after canonical return selected existing-git-reset-v1
symptoms:
  - staged boot requires explicitly admitted cold BOOT_LAUNCH
  - no staged intent or typed probe owner created
tags:
  - staged-boot
  - pool-reuse
  - bootstrap
sources:
  - PR #1525
  - agent root experiment 51 report; v41-command-7d008dbd28ec9ff7/response.json
  - commit 9b037dcaf9515f5cc6d6b75495ded34155599334
repro: python3 scripts/tests/cloudbench-staged-boot.test.py ReusableStagedBootstrap
status: fixed
---

## Problem

Root recorded experiment 51 refusing both children before a staged intent or probe owner existed. The child log said staged boot required the cold flag. The preceding verified return had legitimately changed each resource policy to existing-git-reset-v1. The attempt remains failed; this change does not rewrite its result or release its claims.

## Diagnosis

The existing fleet producer writes a policy-bound cold-primary intent. Its validator returns 1 only for real-empty-bootstrap-v1 and 0 for an existing checkout. After canonical staged runtime validation, claim release and return recording, current_policy yields existing-git-reset-v1. Requiring that per-resource cold flag to remain 1 in run-bench-cloud contradicted reuse. The host transport itself already accepts an exact claimed inert native state without changing its config. The cold flag describes first checkout, not selection of staged transport.

The owning offline sequence uses actual canonical publication/claim and full runtime return fixtures, the actual audit/release path, the next persistent claim, the original cold intent producer and validator, and the unmodified CLI parsing prefix. On old source the second CLI invocation exits 2 with the same message. On fixed source it accepts cold=0/fresh=0. Separate controls keep wrong intent, missing BOOT_LAUNCH, invalid cold flags and cold-without-fresh refusal; the unchanged fetch helper restores tracked content in an existing checkout while retaining unrelated untracked content. These are local fixture results, not a native task pass.

## Solution

Require explicit BOOT_LAUNCH for staged transport, without requiring the first-empty-checkout flag. Leave the independent cold/fresh validation, existing fleet policy and claim guards, staged native/Volume/shape checks, guest first-checkout guard, deadlines, runtime collection and return protocol unchanged. No fallback, retry, resize or new policy is added. Existing warm/reset bootstrap remains the existing code path.

## Human feedback

Root requested the first-run to return to next-CLI sequence, preservation of native and claim guards, no native calls in this lane, and retention of all prior packets. The original 600-task qualification remains pending.

## Reusable lesson

A transport-selection guard must not require a first-initialization flag after the lifecycle has legitimately advanced to reuse.

## Native verification

Attempt 53 reused an existing primary and crossed the formerly rejected staged cold=0 path. Its required N2 preflight passed, followed by a real `parallel-tool-calls` PASS in 97.6 seconds on control `928e5326c1256d7466395151e2192b231b1cd000` and task ref `570830dbf17635e13d16a6f03b4d705f6b6443b1`. The parent lifecycle was verified/exit0; the staged runtime return and claim release were recorded, with claims absent and Machines stopped.

Evidence is retained in `real53-artifacts-1792142781475374527` and `v41-command-605a63d4b33151e5/response.json`. The run hash is `8f3dc7a0419f8b6c09a862248c18abc95be017e93af60e1f8428f196033f5364`; report hash is `c237f30e73f3dcb3b56d6f355884423b9e88f0c85210d2118ca13b48f916f633`. This verifies the reuse transition. No extra worker was launched, and original600 qualification remains pending. Failed attempt 51 is preserved.
