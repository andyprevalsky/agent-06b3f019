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
  - commit eaa16bf18045e9c82007fe67e5dc0b2599ef7521
  - task GitHub Actions run 42909060784
  - task GitHub Actions run 42769391635
repro: agents/benchmarks/code_bench_test.py::test_fixture_git_joins_maintenance_writer_before_archiving
status: open
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
- The quarantine marker (repair `thr_d0600bd7048f45cc9763b229460e6026`) is removed in PR #1931. The test body, assertions and timeouts are unchanged.

The same thread's interim alternative was `-c maintenance.auto=false -c gc.auto=0` in `_git`, with a trace2 no-maintenance-child regression. It was dropped at the main sync, preserving this case's decision to keep maintenance enabled but in the foreground.

## Human feedback

The parent required an owning foreground-maintenance repair rather than ignoring missing files or disabling maintenance. It required no task, scoring, assertion, deadline or concurrency changes, and requested the test-transport portability correction after independent review reproduced the long-path failure. The parent retains integration and full native validation ownership.

## Reusable lesson

Join fixture-owned background writers before taking deterministic snapshots, and test that ownership boundary with an explicit readiness and exit handshake.


### PR1920 occurrence on November 11

The final source a48d69848f424c535fd01e596e940f350eaba39a hit this same worktree archive boundary in GitHub Actions run 42978307776. Native loaded stability run1 passed, run2 failed `test_commit_fixture_missing_origin_fails` when `write_deterministic_tar_gz` attempted to stat an enumerated `repo/.git/objects/maintenance.lock`. The native domain remains FAIL, and the enclosing adapter remains UNVERIFIED/complete=false. The other four stability units each completed five consecutive passes; runs3–5 of this failed unit receive no credit.

The code-bench implementation, original tests, fixture tree, blackbox helper, native runner and selector are identical to baseline06edeba6cbba2389bc11eb48f8ff7bb2f4204aab. The exact permanent wrapper and native-overlap helper functions in the otherwise changed blackbox module are also byte-identical. Gate: NOT_INTRODUCED for this observed archive-input lifetime boundary. Expected inner `judge_failure`, `native_failure` and `unexecuted_native` controls leak into the global failure list only when a separate real case fails; they do not establish independent judge-identity regressions.

The parent-authorized isolated candidate reuses the already reviewed V4 foreground-maintenance implementation and unchanged registered owning regression. On the unchanged a48 implementation, that regression fails with `Git returned while maintenance still owned the archive input`. The same assertion passes five independent candidate executions. The complete owning pytest file passes89 tests in20.03s. These are local ownership and neighboring-suite proofs, not full native loaded stability acceptance or identification of the original CI writer. The CI Python3.11.9/eight-core runtime is recorded; its Git version and original maintenance writer PID remain unrecorded. The later distinct bare-origin receive-pack issue is not folded into this worktree-path occurrence.

No archive member, evaluator assertion, task definition, five-run/load policy, timeout, retry, score or source receipt is weakened. The exact native gate still requires fresh final-source validation by the parent after integration. Original setup/replay failures and native results stay preserved, and this isolated candidate grants no execution, provider, financial, cleanup or deployment credit.
