---
id: 2026-11-10-pid-birth-boolean-nested-subshells
date: 2026-11-10
title: Boolean native PID birth matching forked a nested classification pipeline
surface: infra
component: cloudbench-process-identity
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: cloudbench_pid_matches_start captured birth_state which captured start_time_like which captured the same native process observation
symptoms:
  - boolean match forked nested classification shells
  - observed 4, expected 2
  - cloudbench-multi-workstream.test.sh 0/5 1200s
  - new-test stability: FAIL
  - UNVERIFIED
tags:
  - cloudbench
  - process-identity
  - subshell
  - performance
sources:
  - PR #1881
  - commit eaa16bf18045e9c82007fe67e5dc0b2599ef7521
  - task GitHub Actions 42909060784 focused33
  - task GitHub Actions 42779373058 focused31
repro: bash scripts/tests/cloudbench-pid-identity.test.sh
status: open
---

## Problem

The assigned whole-unit failure persists: `bash scripts/tests/cloudbench-multi-workstream.test.sh` timed out on its first loaded repetition at1200 seconds, with exit null and zero of five consecutive passes. Focused31 occurrence e90c3a71707a40589e3f2c1c2400f106 on12b1 had29 other units PASS. Focused33 occurrence0fdf7f23de0e4fc99509dc43977737d6 on EAA/token0f5cc6fa0d7f4108a7219815fe828eba had28 other units PASS and a separate benchmark failure. Both native aggregates remain UNVERIFIED/complete=false, cleanup_complete=true. Their shared whole-unit command and distinct evidence remain authoritative; this case does not waive either occurrence or the independent benchmark failure.

A separate, reproducible source of repeated process overhead was found in the common PID birth matcher while investigating that timing failure. Its contribution to the whole1200-second cutoff is not established. The case remains open until the assigned original workload is accepted; the local optimization is not a native PASS.

## Diagnosis

On Linux, `cloudbench_pid_matches_start` captured `cloudbench_pid_birth_state`, which captured `cloudbench_pid_start_time_like`, whose native `cloudbench_pid_start_time` captured `cloudbench_proc_pid_observation`. A boolean equality check therefore required three nested command-substitution processes for one native observation. Callers include relay liveness checks and repeated exact-birth revalidation immediately before tree-cleanup signals. The native boot-qualified start tick is correct; the avoidable work is the nested classification/output pipeline, not identity policy.

The new owning regression wraps the real observation reader and records Bash subshell depth. The original helper reads once at depth4 within a depth1 test context; expected one substitution is depth2. The unchanged regression fails original source with `boolean match forked nested classification shells: observed 4, expected 2`, exit1. The candidate reads the same kernel data once at depth2. The canonical three touched files were verified byte-identical to their EAA blobs before integration; no claim is made that this pre-existing helper alone was introduced by the PR or caused all elapsed time.

Paired local measurements under eight load slots made500 real live-birth checks per variant, three times. Mean original time was1.2082 seconds and candidate0.4217 seconds. This measures the primitive only. The approved EAA diagnostic profile contains75,695 successful wait4 completions; even assigning every three to a matcher yields only a loose ceiling of25,231 checks in its incomplete prefix. Applying local timings optimistically gives39.68 seconds, not an observed saving. Most completions are unrelated, profile tracing adds overhead, and separate parent CPU work overlapped. There is no trustworthy per-function native call count or sufficient whole-unit performance bridge.

The one authorized whole EAA offline diagnostic retained1200/eight/all assertions, timed out, and completed owned cleanup with supervisor quiescent=true, orphaned_children=true and remaining empty. Its last completed scenario2k and unfinished scenario3 differ from the original native log; the diagnostic is not a replacement outcome. Its private proof and source manifest are retained. No second whole replay was run for this optimization.

Archive searches `PID birth repeated subshell fork` and `multi-workstream timeout1200` found the2026-10-02 stable-process-birth case and2026-11-10 fake-provider compilation/publication case. The former requires preserving kernel-stable identity and legacy formats. The latter already records other reductions that did not establish original full acceptance. Both lessons are retained; neither supplies a missing whole-timeout causal claim.

## Solution

The exact reviewed candidate ae93fc0ed85bcedbae4cdf387dfd5a26012e447ac77fa4d96d8a5ca47386ca29 changes only the proc-start boolean path to call the existing native reader directly and compare the same identity. Invalid/PID1/unreadable/empty observations still fail. Same-birth zombies still match the global identity predicate. Legacy records still use the original classifier. The richer live/absent/unknown API, reader/parser, signal ordering, retries, clocks, budgets and assertions are unchanged; no caching or new authority is introduced.

The existing PID identity suite adds the depth regression and negative controls, and receives one exact direct structural Gate. All previous registry entries remain. Original regression exit1 is followed by five unchanged candidate exit0 runs. The full owning PID suite passes, including its wall-clock-step checks. An unchanged extracted neighboring block passes native terminal/live/zombie/reaped checks, descendant teardown, stale-root refusal, replacement-before-escalation and asynchronous post-KILL observation. Actual `--lanes-for scripts/tests/cloudbench-pid-identity.test.sh` returns the direct structural lane with exit0 using an isolated external index. An initial missing external dependency was an export-harness error and is preserved separately.

The parent reports independent acceptance of the exact three-file patch and application to its5379 working tree. This case is an external draft; no future commit hash or native acceptance is asserted. Proof73eb7ed53f1e1dddc16c015dd656045ffcd85ae9b6e8cf22f0dd3d6d00929366 and manifest0c642d36d6ceb111c0b86f9fac9f01626e862372b7899c48a13de33818344519 bind the candidate and local command receipts in the private pid-match-cost packet. Whole-unit timing remains UNKNOWN/assigned/blocking pending unchanged native acceptance. No deployment, provider cleanup, financial credit or waiver follows from these checks. Code-only golden reference: no UI, agent behavior, benchmark definition or approval-gated hunk is changed; the existing kernel-identity semantics remain the reference.

## Human feedback

The parent required preserving1200 seconds, five repetitions, eight load slots, every scenario and all assertions. It rejected broad or writable-claim sleep bypasses, prohibited another whole replay, and requested a small source-backed optimization with exact local proof and honest limits. It accepted the exact identity candidate for independent review and required this case remain OPEN. A separate zombie-grace proposal is not part of this patch and has not been used as acceptance evidence here.

## Reusable lesson

A boolean check can reuse the authoritative native observation without routing through nested output classifiers. Prove identity and failure semantics unchanged, register the owning regression, and keep primitive cost savings separate from full-workload acceptance.
