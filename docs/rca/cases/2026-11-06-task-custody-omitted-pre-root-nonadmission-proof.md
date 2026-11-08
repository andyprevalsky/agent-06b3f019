---
id: 2026-11-06-task-custody-omitted-pre-root-nonadmission-proof
date: 2026-11-06
title: A clean pre-root fixture refusal escalated into an unknown root creation outcome because task custody exported no nonadmission proof
surface: harness
component: benchmark-task-root-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py run_single_task task-root custody closed a refusal raised before any create request without exporting positive nonadmission evidence (and its not_started state never covered fixture first-run or Codex creates), so _finalize_owned_cloud_batch could only treat the rootless ERROR row as an unknown creation outcome
symptoms:
  - "RuntimeError: owned cloud execution has an unknown root creation outcome"
  - "FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup acknowledgement"
  - "RuntimeError: owned cloud execution has no proven root allocation"
  - "Live fixture preflight: no injectable browser credential for uber.com"
  - "complete terminal runtime evidence could not be verified -- infrastructure failure"
tags:
  - benchmark
  - cloudbench
  - resource-custody
  - nonadmission
  - preflight
  - cleanup-acknowledgement
sources:
  - fleet run 20261106-125725-4136720 job r001-j0007 (descend-failed-neverrun-20261106 batch 2, campaign campaign-20261106-125707-4128298, source a17dbe5aec)
  - task minted-agent-accounts-uber
  - commit 0d76be10525 (prior bespoke initial Claude-skip proof; related case 2026-10-17-queued-cancellation-omitted-nonadmission-custody)
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_live_fixture_refusal_before_root_creation_finalizes_nothing_to_clean
status: fixed
---

## Problem

In fleet run `20261106-125725-4136720`, job r001-j0007 ran
`minted-agent-accounts-uber` on guest 8111695f4635d8 at source a17dbe5aec. At
13:25:21Z the live-fixture preflight correctly refused before any agent existed:
`Live fixture preflight: no injectable browser credential for uber.com ... 0
CookieBundle row(s) ... 1 enabled SteelSessionAuth marker(s) (not injectable on
their own)`. The saved task row had `agent_id: ""`, `owned_roots: []`,
`graded_root_creation_outcome: "not_started"`, `status: ERROR`, `logs: {}`.

`_finalize_owned_batch_and_save_run` then raised `owned cloud execution has an
unknown root creation outcome` (traceback at run_benchmark.py:7160), wrote
`Benchmark interrupt cleanup status: state=failed`, and cloudbench-run.sh refused
the guest cleanup acknowledgement (`benchmark root cleanup was not confirmed`).
The controller then reported `complete terminal runtime evidence could not be
verified -- infrastructure failure` and the status server answered 409. A clean,
correctly classified INFRA/fixture refusal became an incomplete-evidence cleanup
failure. The missing uber.com login itself is a separate human-login fixture gap.

## Diagnosis

Critical path: catalog task -> `_run_reported_task` (coordinator) ->
`run_single_task` custody -> `_run_single_task_as_run_user` ->
`_apply_live_fixtures` -> `_assert_live_cookie_domains_usable` raises -> exception
path builds rootless ERROR TaskResult -> `_bind_task_root_custody` ->
`_finalize_owned_cloud_batch` -> runner interrupt-cleanup status file ->
`cloudbench-run.sh publish_cleanup_ack`.

- The preflight data is correct (refusal before `create_agent`, verdict ERROR).
- The guest refusal is a correct consequence of `state=failed`.
- First bad: the finalizer accepts a rootless non-SKIPPED row only with a
  producer proof of nonadmission (coordinator queued-cancellation proof or the
  initial Claude-credential preflight proof, both bound by exact result-object
  identity). `run_single_task`'s custody had positive knowledge that no create
  request had been issued but exported nothing. Its `graded_creation` state could
  not serve as that proof: it flipped to `unknown` only around the graded create,
  so a fixture first-run create (`_run_auth_test_site_first_run`) or the Codex
  anchor create whose response was lost also left `not_started` with no roots.
  The finalizer therefore treats every such row as unknown (fail-closed), which is
  correct for the data it received.
- Deepest owned cause: task custody did not record every allocation attempt in
  its scope, so it could not produce the nonadmission proof. Every pre-root
  refusal inside `run_single_task` hit the same wall: live/other fixture
  preflights, payment-identity preflight, and the dispatch-time Claude/Codex
  credential skips (SKIPPED, which fail as `no proven root allocation` in a
  single-task guest). The two earlier fixes (2026-10-17 queued cancellation,
  2026-11-03 commit 0d76be1 initial Claude skip) each added one bespoke proof for
  one refusal producer; this is the third instance of the same class.

Archive searches run: `owned cloud execution has an unknown root creation outcome
benchmark root cleanup was not confirmed refusing guest cleanup acknowledgement`
and `preflight refusal before root creation not_started cleanup failure nothing to
clean`, plus a literal grep. Relative (not recurrence) of
2026-10-17-queued-cancellation-omitted-nonadmission-custody: same symptom, a
different producer (task custody instead of the coordinator). Its rule that a
forged `not_started` is not proof was kept.

Reproduction (actual `_run_reported_task` AST, actual `run_single_task`,
`_apply_live_fixture`, `_assert_live_cookie_domains_usable`, `create_agent` and
`_finalize_owned_cloud_batch`; only sync/DB-summary/HTTP edges faked with the
observed uber.com counts):

```text
cd agents && python -m pytest -q benchmarks/cloud_batch_cleanup_test.py -k "before_root_creation or create_response"
# base a17dbe5aec bytes:
E RuntimeError: owned cloud execution has an unknown root creation outcome   (live fixture refusal)
E RuntimeError: owned cloud execution has no proven root allocation          (dispatch Claude skip)
2 failed, 3 passed
# fixed: 5 passed; whole file 90 passed
```

## Solution

Task custody now records and exports nonadmission generically:

- `_open_task_root_custody` adds `allocation_attempted` and a `parent` link.
- `_mark_task_root_creation_attempted()` runs at the top of `create_agent` (the
  allocation primitive for graded and fixture first-run roots) and before Codex
  dispatch, marking every enclosing custody so composite stages cannot let an
  outer result claim absence. (Epoch 27 unified I-07's original
  `_mark_task_root_allocation_attempt()` with main's identical mark; the one
  function sets both `allocation_attempted` and `root_creation_attempted`.)
- `_close_task_root_custody` binds the final result; only an outermost custody
  with no attempt, no roots, `not_started`, a rootless non-passing result with no
  logs and no prior `stop_metadata` stamps `TASK_CUSTODY_NONADMISSION` and reports
  the exact result object.
- `run_single_task` opens custody before the dispatch credential skips, so those
  refusals carry the same proof.
- The coordinator appends that exact object to `_never_admitted_results` only
  when it is the returned result and no root was registered; the finalizer adds
  a `rootless_custody` category (identity + strict fields), so nothing-to-clean
  is confirmed and the verdict, failure reason and attempts are unchanged.

Fail-closed controls retained: lost graded create stays `unknown`; lost fixture
first-run create stays rejected (mutation-checked by removing the marker);
copies, forgeries, duplicate proofs and changed fields are rejected; nested
stage attempts block the outer proof (mutation-checked). At 10k agents this is
O(1) per task: one dict flag and at most one list append; no extra requests.

Outcome proof pending: a local `scripts/run-bench --local` run never enters the
owned cloud batch finalizer, so the exact outcome needs a fleet rerun of the
task showing ERROR with a published guest cleanup acknowledgement. The uber.com
login remains a separate human fixture action.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When a deferred cleanup verifier demands proof that nothing was allocated, have the scope that owns every create attempt record attempts before each request and export identity-bound nonadmission itself, instead of adding one bespoke proof per refusal path.
