---
id: 2026-11-08-code-close-timeout-discarded-result-before-lease-release
date: 2026-11-08
title: Code-session close timeout discarded its result and completed the spawn before releasing the session lease
surface: cross
component: code-session-close
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/repo.py close_e2b_session returned an empty dictionary on ReadTimeout while the backend close was still running
symptoms:
  - "[ClaudeCode] Failed to close session error=ReadTimeout"
  - "[ClaudeCode] Session closed output_files=0 claude_code_usage=null"
  - "CODE_SESSION_BUSY"
  - "Required output artifacts were not completely extracted - incomplete."
tags:
  - code-sessions
  - close
  - timeout
  - lease
  - handoff
sources:
  - agent 0874662a-afaf-4d24-b411-af99649108ad
  - task e6161c88-9577-42aa-92eb-64d49b3ce01f
  - agent session 2256e1eb-121d-463e-b3b3-6d47d883ce99
  - commit 436727a0e6bde5e77d4463f246d8bf87618ca15b
repro: back-end/src/tests/blackbox/code-sessions-close-confirmation.cases.ts
status: fixed
---

## Problem

A production user asked to remove the rose border around the update card. The first
Claude Code task finished at 03:54:32.874 UTC on November 8, 2026. Closing the task
started at 03:54:34.515. Worker logs record ReadTimeout at 03:57:34.466, immediately
followed by "Session closed" with zero files and no usage at 03:57:34.467. The
parent received FAILED at 03:57:35.239 and explicitly reused its code_session_id.
That retry failed at 03:57:49.328 with HTTP 409 CODE_SESSION_BUSY. The backend was
still closing the first task: it logged a checkpoint timeout at 03:58:03.632,
released the lease at 03:58:03.937 and closed the task at 03:58:03.950. Read-only
production DB queries and retained Render/ClickHouse logs agree on this sequence.
The next default spawn forked a second session instead of continuing the first.

No agent self-report exists: the production report-bug/by-agent API returned
report:null. The first CLI genuinely did not perform the requested edit: it
misidentified the updater chip as neutral and wrote an empty modified_file path.
That missing required artifact remains a legitimate incomplete task, not a false
success or a proven model-intelligence limitation. The later session found
LiquidMetalRing and was steered by the user. This RCA repairs session closure,
not the separate UI edit or the model's interpretation of the ambiguous request.

## Diagnosis

Path: CLI final result -> worker close HTTP -> backend handoff/files/checkpoint ->
provider pause -> CodeSession lease release/task CLOSED -> verifier -> parent
notification -> next spawn's session resolve. Binary-searching at the API/worker
boundary found that completion notification preceded backend completion.

The worker catches transport and HTTP errors and returns {}, indistinguishable
from a confirmed close with no files. It then verifies a fabricated empty result
and tells the parent the task ended. Meanwhile the backend correctly retains its
lease until checkpoint/pause settle. A truthful busy guard then rejects the
premature reuse. Raising a timeout or clearing the lease early would leave this
protocol defect intact and could pause a newer live CLI underneath its owner.
The backend also consumes handoff.json before pausing and returns empty files
for a CLOSED replay, so merely retrying the POST loses the original output.
The deepest owned cause is missing durable, replayable close acknowledgement.

Archive searches: CODE_SESSION_BUSY (no exact hit), Required output artifacts
were not completely extracted, and checkpoint close timeout. The disabled-verifier
case 2026-10-23 is a relative: this task truly lacked a required file. The historical
T3 lifecycle thread had explicitly left the 300-second checkpoint vs 180-second
caller and silent-null issue open. Its owner was sent this incident's evidence;
no competing active repair was found. An independent investigator read actual
active Bug Report handoffs across the project and reconciled the exact-agent FE
owner, whose work is UI wording/navigation/task-name metadata, not this repair.

The checkpoint is a contributing separate failure: profiling the same paused
sandbox with createCheckpoint on source 436727 reproduced a 362,779,835-byte
worktree against the unchanged 209,715,200-byte cap. Scan took 1.057s, repository
inspection 1.742s, and archive/download dominated the 69-second diagnostic.
The original production error was a 206-second operation timeout, not a recorded
cap failure; do not equate those error strings or claim the diagnostic proves
which original checkpoint suboperation timed out.

Local regressions in the owning worker and backend suites were run RED before
implementation: the worker completed after a ReadTimeout, a CLOSED replay lost
handoff/facts, overlapping closes returned different output, and pause errors
were falsely successful. The exact unchanged focused command is:
`cd back-end && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca087_close DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca087_close node --import tsx --test --test-name-pattern='close confirmation' src/tests/blackbox/code-sessions.blackbox.ts`.
The original eight assertions failed on the pre-fix backend; the six independent
review regressions failed on the first repair; a seventh review regression
failed on the second repair when transaction admission failed before any pause
RPC. Final code passes all 15 assertions five consecutive times unchanged.
The two worker regressions also fail before and pass five times after; the full
registered spawn-claude-code-agent domain passes. New backend cases are imported
and registered from the existing code-sessions.blackbox.ts suite.

## Solution

The worker reconciles only the same task's close under heartbeats, retaining the
existing 180-second per-request bound. Three unsuccessful requests raise a typed
non-retryable CodeSessionCloseUnconfirmed error instead of fabricating empty
completion or retrying the whole code spawn. The backend stores one durable,
task-owned closeResult receipt with handoff, stable upload IDs, files, usage and
frozen session facts. Overlapping closes share task-keyed serialization; CLOSED
replays return the same receipt without reconnecting the sandbox or re-uploading.
Cleanup derives identity from the persisted task owner, and local shutdown saves
its common receipt before its own terminal DB write.

The first adversarial review proved four additional gaps in the repair, which
were fixed and regression-tested: a newer owner could arrive between the final
receipt save and pause; cleanup without repeated identity sealed empty output;
local final-write failure lost its replay; and an expired mutex could write stale
state. Per-session closingTaskId/closingEpoch now retain close custody across
transport uncertainty, including an expired ordinary spawn lease. Receipt writes
are fenced by the task-mutex token. Only the final pause/state-confirmation RPC
holds the task-mutex and session row locks (60-second provider request,
65-second transaction); extraction, checkpointing and uploads run outside it.
A dispatched but unconfirmed pause is observed without reconnecting or resending;
known pre-dispatch failures can retry collecting. A second review reproduced a
pool-admission failure before dispatch, and the explicit dispatched flag fixes
that distinction. Tests preserve both a late physical pause and safe non-dispatch
retry. No process/CLI restart is used to recover a lost close reply.

The reference-source recurrence is repaired and verified in the existing November
6 checkpoint case. All original caps, output requirements and real busy-owner
protection remain. No benchmark task or definition changes are involved; this was
a production user agent, not a benchmark. Golden-reference review rca-0874662a-close-v3 returned GROUNDED with Code PASS
from independent reviewer ph7cmzkx3gp8nzrn485j94t1f18hve0a. Its exact mandatory
runtime diff SHA256 is 9aaabc1107d1dd74988c646c3c4c0e9be7e19014c8250edd6a928cf685985534.
Expanded reference setup and old-default upgrade review also passed. Production
deployment follows
the normal full gates and does not follow from focused proof alone.

Golden references opened for the final design/review: Codex
codex-rs/codex-client/src/retry.rs:23,93 retries the same HTTP request with bounded
transport/429/5xx policy and returns explicit exhaustion;
codex-rs/exec-server/src/client_recovery.rs:364 reconciles an existing session
identity under a bounded recovery deadline. Hermes
tools/process_registry_results.py:48,86 stores and retrieves owner-scoped completed
receipts; its write-error path warns rather than promising durability. Claude
Code src/tools/TaskOutputTool/TaskOutputTool.tsx:219,253 distinguishes timeout and
not_ready from completed output; src/tasks/LocalAgentTask/LocalAgentTask.tsx:412
stores terminal status and actual result together. OpenClaw's
src/gateway/agent-turn/agent-dedupe.ts:170 replays by run identity, but that cache is
in-memory, not a database-durability precedent. Rose's distributed provider custody
is an application-specific adaptation, not a claim those harnesses implement E2B
fencing. Local precedents were read before implementation; golden analogues were
opened during adversarial review, which corrected the initial design.

At 10,000 agents, receipts, custody and mutex rows are task/session-keyed, with no
user/root fan-in or shared counter. The final bounded pause temporarily uses one
pooled connection per concurrent transition, so DB pool backpressure is a real
limit; a pre-dispatch admission failure safely retries, as the regression proves.
Long checkpoints do not hold transactions. A crash after actual dispatch may
remain explicitly unconfirmed until the provider reports paused; custody is not
released speculatively. A legacy CLOSED row without a saved receipt reports its
missing result rather than inventing one. Native CLI request dumps are not
captured by Rose's dump pipeline; native transcript events and the last retained
root execute_loop dump are preserved as distinct evidence.

## Human feedback

The user required reading other active bug threads, including Bugs and Bug Report
runs, and matching their actual work and evidence before editing. Matching owners
must receive evidence and reconcile rather than duplicate repair. The user also
required completing /deploy after /rca.

## Reusable lesson

Do not turn an unacknowledged resource close into an empty completed result; preserve its task identity and replayable receipt until custody is released.
