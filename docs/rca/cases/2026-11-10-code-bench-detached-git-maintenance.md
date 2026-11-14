---
id: 2026-11-10-code-bench-detached-git-maintenance
date: 2026-11-10
title: Fixture Git maintenance can outlive the command before deterministic archive creation
surface: harness
component: code-bench-archive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Fixture Git returns without joining automatic maintenance before os.walk and tar.add consume its mutable repository
symptoms:
  - FileNotFoundError on repo/.git/objects/maintenance.lock
  - FileNotFoundError on origin.git/objects/maintenance.lock
  - code_bench_evaluator_proofs_permanent_gate
  - Git returned while maintenance still owned the archive input
tags:
  - code-bench
  - git
  - maintenance
  - archive
  - race
sources:
  - PR #1881
  - PR #1931
  - commit 6ec73775eb17e051cb64c1d0153968596c2a94c9
  - task GitHub Actions run 42956070487
  - commit eaa16bf18045e9c82007fe67e5dc0b2599ef7521
  - task GitHub Actions run 42909060784
  - task GitHub Actions run 42769391635
repro: agents/benchmarks/code_bench_test.py::test_fixture_git_joins_maintenance_writer_before_archiving
status: fixed
---

## Problem

On EAA focused33 stability, the benchmark domain passed three repetitions then failed run4. The nested evaluator subprocess passed86 tests and failed test_reference_solution_passes[commit-locally-no-push] and test_commit_fixture_missing_origin_fails. Both failed while tarfile tried to stat a previously enumerated .git/objects/maintenance.lock. Historical79e run5 had the same missing-path boundary in three cases. These are separate native results. EAA aggregate remains UNVERIFIED/complete=false/cleanup=true with two failing units; the separately assigned1200s controller timeout is not repaired or waived here.

## Diagnosis

write_deterministic_tar_gz enumerates the fixture tree, then stats each path while adding it to the archive. The native lock disappeared between those operations. Fixture setup and reference commits call code_bench._git, which previously allowed Git's automatic maintenance to detach and therefore did not guarantee a quiescent repository when returning.

The native writer PID and Git version are not recorded. Automatic maintenance as that specific writer remains an inference, not recovered historical process proof. Independently, the owned Git-return contract is reproducibly defective: a controlled actual child writer held at a readiness/release barrier survives the original helper's return. The same test passes when the helper requests foreground maintenance. A separate real Git2.43 probe forces auto-GC with valid loose objects; Trace2 confirms GC exits before the corrected maintenance command returns, and archiving succeeds. The simulated child contract and real-Git probe prove distinct boundaries and are not described as a full native reproduction.

The existing deploy-gates workflow already supplies gc.autoDetach=false and maintenance.autoDetach=false for its mutable mirror. Git2.43 documents gc.autoDetach's background-return behavior; its observed GC join is attributed to that flag. Applying the established pair to the temporary fixture Git calls covers init/commit/clone/fetch helpers without disabling maintenance or excluding repository metadata. The command's existing60s timeout remains unchanged.

## Solution

External candidate, not yet integrated: add the two foreground flags to code_bench._git and add the child-writer regression in the existing code_bench_test.py. Preserve every archive member, evaluator assertion, task definition, prompt, score, timeout, five-repeat requirement and eight-slot load policy.

The original regression fails, and five unchanged candidate repetitions pass. The full owning pytest suite passes89 tests; all seven fixture archives are byte-identical before and after the implementation. The benchmark permanent gate invokes this complete pytest file. The file-level --lanes-for helper does not discover that nested registration and reports NOT RUN; this diagnostic is not represented as direct selection proof.

Independent review found that the first new regression used an AF_UNIX socket path that exceeded platform limits under a valid long pytest base directory. That candidate and failure are retained. V2 changes only the test transport to an already-bound ephemeral127.0.0.1 TCP port, preserving readiness, release and process-exit EOF. It does not use a fixed port, external network, path workaround, delay or skip. V2 is checked at the same long path and at normal paths five times, plus the whole owning suite.

Native full five/eight stability acceptance remains pending after parent integration of all required repairs. The case stays open. This candidate does not close the original mixed aggregate, prove the unknown native writer, settle financial obligations, or grant cleanup/test/deployment credit.

### Authenticated test IPC correction

Independent review rejected V2 after a normal run accepted an unknown first TCP peer, producing a malformed readiness frame and wrong EOF byte. That peer's identity is unrecorded. A separately owned HTTP-like first-peer control reproduced the failure; this does not identify the spontaneous peer as HTTP.

V3 retains the ephemeral loopback transport but authenticates readiness with a fresh high-entropy per-test nonce. A bounded frame parser services the listener and pending peers under one monotonic10s deadline, rejecting foreign, malformed or wrong-nonce frames without resetting the deadline. Silent peers do not block acceptance of the owned child. The existing release and process-exit EOF assertions remain. The unchanged reviewer first-peer control, wrong nonce, silent-peer and malformed authenticated-frame controls pass; normal and long-path runs each pass five times. The complete owning89-test suite passes again. Production _git bytes and its timeout are unchanged from the already reviewed implementation; prior V1/V2 candidate and rejection evidence remain historical.

### Unauthenticated peer reset correction

The independent reset-first control then found a V3 transport error: ConnectionResetError from an unauthenticated peer aborted the receive loop. V4 closes only that unauthenticated connection and continues under the same original deadline; an aborted accept is handled equivalently. Errors on the authenticated child's release/EOF path still fail. The exact reset-first control, earlier foreign-peer controls, normal/long-path repetitions and complete owning suite are rerun. No production Git behavior or deadline is changed by this transport correction.

### 2026-11-11 repair handoff (FLAKY occurrence be7609ba9f2a48879ca405c3ba6a49a3): local Git 2.56 reproduction and unquarantine

PR #1915 quarantined `test_commit_fixture_rewritten_history_fails` after the same `maintenance.lock` FileNotFoundError at source 9905809a4. The repair thread reproduced it locally; the stock devbox Git 2.43 never fails.
- Git 2.51 daemonizes `maintenance run --auto --quiet --detach`, but its exiting parent still removes the lock before `git commit` returns (strace: parent unlink 0, daemon unlink ENOENT).
- Git 2.56.1 `daemonize()` calls `reassign_tempfile_ownership(parent, child)`, so the detached child owns `objects/maintenance.lock` past the command's return.
- With a locally built Git 2.56.1 (`make NO_RUST=1`), the unquarantined test body was run 25 times in each of 24 parallel workers on main 72186aa4d. About 340 of 600 runs failed with the exact error.
- On main with the foreground flags from this case (`gc.autoDetach=false`, `maintenance.autoDetach=false`, plus the receive-pack fix 940b77d01a), the identical harness passed 600 of 600. The full `code_bench_test.py` passed 90/90 under Git 2.43 and 2.56.1, and the unquarantined test passed 5/5 consecutive runs.
- Main released the quarantine marker (repair `thr_d0600bd7048f45cc9763b229460e6026`) at its five-pass deploy streak in dab14eab09. On main 5f38450c71 the same contention harness passes 600/600 and the test 5/5. Test body, assertions and timeouts are unchanged. With the integrated foreground fix, the released marker and this local fail-before/pass-after reproduction, the case is fixed.

The same thread's interim alternative was `-c maintenance.auto=false -c gc.auto=0` in `_git`, with a trace2 no-maintenance-child regression. It was dropped at the main sync, preserving this case's decision to keep maintenance enabled but in the foreground.

## Human feedback

The parent required an owning foreground-maintenance repair rather than ignoring missing files or disabling maintenance. It required no task, scoring, assertion, deadline or concurrency changes, and requested the test-transport portability correction after independent review reproduced the long-path failure. The parent retains integration and full native validation ownership.

## Reusable lesson

Join fixture-owned background writers before taking deterministic snapshots, and test that ownership boundary with an explicit readiness and exit handshake.


### 2026-11-11 receiving-side recurrence

Source6ec diagnostic run4 failed after three benchmark passes: the nested owning suite had1failed/88passed in test_commit_fixture_new_remote_branch_fails, with origin.git/objects/maintenance.lock disappearing during tar.add. Aggregate30PASS/2FAIL remains UNVERIFIED/incomplete; the whole1200-second controller failure is separate. The native writer PID and exact Git version remain unrecorded.

A canonical local fixture/push with real Git2.43 Trace2 proves that sender -c flags do not reach receiving gc. An environment-only GIT_CONFIG_COUNT control also failed to propagate those settings. The smallest external candidate therefore configures gc.autoDetach=false and maintenance.autoDetach=false inside the fixture-owned bare origin before use. It does not disable maintenance or omit archive members. The actual receiving-gc regression is RED on original source and GREEN after this change. A held-writer model additionally exercises the bare-origin ownership boundary while retaining the previous direct-writer control.

Five unchanged focused runs pass all three cases and the full owning suite passes91 cases (the89existing expansions plus two new receiving-boundary expansions). All seven fixture archive member sets and normalized metadata are unchanged. Six archives remain byte-identical; only commit-locally-no-push/origin.git/config changes, by the two explicit foreground settings. Every other member byte is identical. The existing unauthorized remote branch still produces exactly git.origin_unchanged. No prompt, evaluator, timeout, sample, retry or assertion was weakened. This config-only archive delta is intentional, not claimed byte-identical to its old baseline.

This is an external candidate pending integration and the full original32-unit/five/eight/1200 validation. It does not reproduce the historical writer identity or claim the original native failure fixed. The parent authorized the bare-origin settings only after the environment-only propagation control failed.
