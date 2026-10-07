---
id: 2026-10-07-cancelled-initial-browser-request-lost-allocated-owner
date: 2026-10-07
title: Browser cancellation lost a session allocated during initial credential preparation
surface: cross
component: browser-session-preparation-ownership
classification: our-bug
problem_class: other
first_bad_boundary: _spawn_browser_agent_activity_v3_real cancelled its initial session request before receiving the backend-allocated session handle
symptoms:
  - "archive: TimeoutError"
  - "browser archive refresh exceeded its readiness bound"
  - "preparation cancellation discarded the allocated session owner"
tags:
  - browser-session
  - cancellation
  - provider-ownership
  - durable-evidence
  - recording
sources:
  - PR #1299
  - commit 9a55d781547780d0c71e6aafa11965eda754a202
  - commit a015f2e81e989de1c1f5bc2414c0eaa6fc2f3a9a
  - commit 72730a6692eafcefd22b1a8d85a36d2adc036592
  - fleet run 20261007-185005-80376
  - agent 52f46ca8-4ad1-4af7-b47c-e141af580c19
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py and agents/tests/blackbox/benchmark.blackbox.py
status: open
---

## Problem

The immutable original Control9 `minted-agent-accounts-uber` task has ordinary
`benchmark_status=FAILED` while its executor snapshot has `status=ACTIVE`,
115 messages, missing `logs.tree`, null `archive_manifest_ref`, and cleanup
warning `archive: TimeoutError`. The benchmark verdict does not establish a
terminal executor snapshot. Exact cleanup separately verified both
Steel sessions closed, the original root deleted, and its tree sealed. The run
is fully released and receives zero credit. Its verdict and original evidence
remain unchanged.

Original receipts live under
`.context/fleet/runs/20261007-185005-80376/minted-agent-accounts-uber/remote-logs/runtime-evidence/`
in the original Control9 checkout. `run.json` has SHA-256
`fb5e7e18e93a0d660c9fd17298024f112e7a736e397811b5e9ce8b9a18b92e55`.
The first browser task `fd24bdd4-e364-5238-ba98-0fc12eec4c2d` already has a
terminal and FINISHED recording. The second task
`6caf564b-c87b-55b4-b2d6-63a2b428261a` has terminal events and allocated Steel
session `267a8635-20b3-4bb7-91bd-1c6549169443`, but no recording attachment.

## Diagnosis

The worker began the second initial session request at 19:17:08.726481 UTC.
The backend was preparing its allocated session by 19:17:17.007. At
19:17:21.410508 the caller paused and canceled the worker. Worker cleanup
finished at 19:17:24.111139, while the original backend request continued
credential preparation through its 19:17:32.016 response. The worker's session
local was assigned only after that response; cancellation therefore discarded
its exact handle and skipped the activity's session close. These timestamps are
in `logs/worker.log` lines 7206–7228 and `logs/backend.log` lines 5865 and 6036.
The later exact root cleanup recovered and closed the session, but could not
recover a worker recording that had never been initialized at this boundary.

The same owning initial-request block, cancellation block, transport function,
backend session service/routes, and archive readiness/refresh functions are
byte-identical in the original source, reviewed composed `a015f2e8`, and
production `72730a669`. The later approval-fence fixes do not repair this
pre-acknowledgment boundary. An existing owning activity blackbox reproduces the
lost handle on `a015`: `test_browser_preparation_cancellation_retains_exact_allocated_session`
fails with `preparation cancellation discarded the allocated session owner`.
The identical test passes with the staged owner fix.

Joining and closing that owned request alone does not satisfy the archive rule:
the recorder is created after session acknowledgment and browser setup. The
existing benchmark blackbox
`test_cancelled_preparation_archives_only_with_positive_task_and_owner_proof`
then separately fails with `TimeoutError` on the reviewed baseline, despite a
positive task-scoped preparation receipt and exact allocated-session inventory.
It passes with the staged archive contract. Its fixture includes an earlier
browser task that really ran and still owes its recording.

Archive searches used `archive: TimeoutError browser_readiness`, `browser
recording task_complete paused archive missing terminal`, and `session init
cancellation allocated recording missing`. The September 29 zero-allocation
case is related, but its root-wide zero-session proof cannot cover an allocated
preparation task alongside an earlier recorded task. The September 6 missing
terminal case has a different first-bad boundary. This is a distinct ownership
failure, not a recurrence of an approval stall.

Missing `task_started` or action markers in the original transcript alone
cannot positively certify that the original task did no browser actions; lost
persistence remains an attribution gap. The staged positive receipt is emitted
only by the actual initial-preparation cancellation branch after joining the
same request. It is not backfilled into the original evidence. The later
original API observer returned 503; earlier 403/404 observations used mistaken
observer scopes. None proves archive corruption or repairs the missing bundle.

## Solution

The isolated staged fix shields and joins the same initial HTTP operation
inside its unchanged transport bound. It does not replay session creation.
Cancellation adopts only the returned handle for its already allocated task,
closes that exact session, and emits actual lifecycle metadata on the existing
FE-only cleanup terminal. Repeated cancellation still joins the same operation.
Failed or foreign acknowledgments remain unknown and receive no pre-action
certificate. The code introduces no backend phase registry or database schema.

Archiving recognizes a preparation receipt only when task, tool call, root,
provider, and session match the current exact root inventory. Publication also
requires the unchanged exact tree in terminal snapshots, a deleted/sealed root,
and the real native provider-close receipt. Any started or recordable action,
unknown phase, foreign handle, missing native close, or absent positive receipt
retains the recording requirement. Existing model-visible task messages,
prompts, outcome rules, evaluator, and timeout values are unchanged. At scale,
ordinary tasks perform no extra root query; only this positively identified
cancellation shape invokes its exact inventory read. Related transcript phases
are indexed once by task/tool-call identity, and exact sessions are counted once
by agent/provider/session identity, preserving duplicate and unknown rejection
without rescanning the snapshot for each receipt.

Frozen RED/GREEN proof, unchanged commands, original receipt hashes, source
boundary hashes, and staged patch are in
`.context/minted-durable-gap-rca/` in isolated worktree
`rose-minted-archive-rca-20261007`, branch
`codex/minted-session-preparation-cancel-20261007`. Both owning reproductions
failed on baseline runtime source and passed with the staged patch. Seven
focused activity checks, two archive checks, and the existing hermetic publisher
script pass, including started/unknown/foreign-owner and duplicate-cancel
inverses. The patch is staged for independent review, not deployed. No paid
calls were made and no active control source was modified.

This case remains open: no exact unchanged live benchmark before/after outcome
has been established. The original durable evidence remains missing and
immutable; a future real control must prove archive publication end to end.


### Independent source qualification

The final source was committed and uploaded as
`12e5117e73c390dfd0018d4c6a4413a2aa38c302`. Independent review verified the
frozen owner/archive RED/GREEN hashes and all ten source files, then ran seven
activity controls, two archive controls and the existing publisher suite: all
passed. The linear validation revision preserves the positive and inverse
assertions. This establishes source qualification; the original missing
durable evidence and zero acceptance credit remain unchanged, and the case
stays open pending a real unchanged live before/after outcome.

## Human feedback

The user permits ordinary terminal failure and early cancellation when honest
durable preparation metadata and exact provider closure prove that task actions
never began. Actual browser actions still require their recording. They
required preservation of original evidence/outcomes, no task, prompt, model,
evaluator, or timeout changes, and no intervention in active controls. The parent
specified that the fix should join the same existing init request, preserve its
actual returned owner, and test whether proper closure alone repaired archiving
before adding a preparation exception. No synthetic action, model nudge, or
retroactive proof is permitted.

## Reusable lesson

Keep a canceled resource-creation request owned until its acknowledgment settles, then bind any pre-action archive exception to that actual task phase and exact provider closure.
