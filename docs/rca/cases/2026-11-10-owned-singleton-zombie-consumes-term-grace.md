---
id: 2026-11-10-owned-singleton-zombie-consumes-term-grace
date: 2026-11-10
title: Owned singleton zombie consumes the full process-tree TERM grace
surface: harness
component: cloudbench-environment-tree-teardown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_terminate_tree_and_wait uses birth ownership as execution liveness during its TERM grace loop
symptoms:
  - exact-birth zombie descendant consumes full TERM grace before successful cleanup
  - original helper waits three seconds with only a terminal owned descendant remaining
  - final teardown verification already accepts the same zombie as non-executing
tags:
  - cloudbench
  - process-ownership
  - zombie
  - teardown
sources:
  - PR #1881
  - commit 5379ad9d60ccd915bee674623b4bbd2f97e70632
  - plan:/var/tmp/cmd-deploy/resume/zombie-grace-independent/result.json
repro: bash scripts/tests/cloudbench-env.test.sh
status: open
---

## Problem

The owned-tree TERM grace loop treats an exact-birth zombie as still running, although final verification accepts it as terminal. This is a reproduced helper defect. It is not a proven cause of the separate EAA whole-unit1200-second timeout; the original full five/eight acceptance remains required and blocking.

## Diagnosis

A deterministic Linux subreaper keeps an exited descendant unreaped after TERM retires its root. Original cloudbench_terminate_tree_and_wait returns0 after3.086seconds with grace3, versus0.082seconds with grace0, while the exact child remains nativeZ. Both test-owned children are joined afterward. No existing resources or provider are involved.

The source calls cloudbench_pid_matches_start during grace; that is an ownership predicate, so same-birthZ remains true. Final verification has a distinct execution-state check. The proposed correction is confined to grace: accept only freshly rechecked exact-birth LinuxZ with an descriptor-enumerated singleton task directory. A zombie leader with live peers must continue waiting. The global matcher, signal order, final verification and deadlines remain unchanged.

Archive searches were `cloudbench_terminate_tree_and_wait zombie grace` and `exact zombie terminal process cleanup`. The September27 environment-tree case is a relative about a test assertion using PID existence, not this production grace loop. The November8 singleton-zombie memory-sampler case supplies the necessary live-peer warning: a zombie leader alone does not prove its thread group is terminal. That lesson is retained by the singleton task check and a real live-thread negative.

## Solution

External additive proposal only: skip further TERM grace waiting for that exact singleton terminal state. Keep all unknown, mismatched, multi-thread and changed observations conservative. Preserve the independently reviewed global matcher optimization as its own prerequisite. No source application or native acceptance is claimed.

## Verification

The new owning regression's original-helper invocation fails its unchanged assertion that a singleton zombie must not consume a real grace sleep. The proposed helper passes the same assertion. Focused controls cover a mixed live/zombie forest, a native zombie leader with a live writing thread, unknown observations, changed birth and changed state between checks. Unknown identity still returns failure. An independently reproduced GLOBIGNORE bypass rejected the earlier shell-glob draft; direct native directory enumeration now ignores caller glob filtering and fails conservatively when enumeration is unavailable. Permanent controls also cover that real live-thread exploit, enumeration failure, and noglob/failglob caller settings. Observational sleep recording calls the actual sleep unchanged; no logical clock or suppressed wait is introduced. The final five unchanged repetitions and existing teardown neighbors are recorded in the accompanying validation receipt; full native gating remains pending.

The observer of the original EAA diagnostic selected only current descendants and dropped rows when fd1 was unavailable, so its zeroZ samples do not prove absence. The trace lacked target-birth tables and signal delivery. No historical30-second interval is attributed to zombies from that incomplete bridge.

## Human feedback

The coordinator requires unchanged1200 seconds, five repetitions, eight load slots, assertions, retries and real late-guest behavior. The proposal must not change the shared matcher or final verification, and must remain pending independent review and native validation. No user-facing test or financial outcome is inferred.

## Reusable lesson

Use ownership identity to decide whom teardown may target and fresh execution state to decide whether grace waiting is useful. A singleton zombie is terminal; a zombie leader with live threads or unreadable state is not proof of a quiescent thread group.
