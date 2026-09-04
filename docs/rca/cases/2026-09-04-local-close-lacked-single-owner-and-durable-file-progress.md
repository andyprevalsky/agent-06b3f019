---
id: 2026-09-04-local-close-lacked-single-owner-and-durable-file-progress
date: 2026-09-04
title: Local Claude Code close lacked a single task owner and durable per-file progress
surface: back-end
component: claude-code-local-session
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/claudeCodeLocalSession.ts:closeLocalClaudeCodeSession
symptoms:
  - overlapping local Claude Code closes upload outputs and update CLOSED twice
  - one failed output upload is silently persisted as a complete partial outputFiles list
  - retry skips a missing local Claude Code output file
tags:
  - claude-code
  - local-session
  - singleflight
  - durable-progress
  - partial-upload
sources:
  - PR #1246
repro: back-end/src/tests/blackbox/claude-code-local-close.blackbox.ts
status: fixed
---

## Problem

Two close requests for the same backend-local Claude Code task could execute the
entire close sequence concurrently. Each could extract and upload the same
files, terminate the same child, and write the same database transition.
Separately, the extraction loop caught an individual upload failure and returned
the successful subset. Close then persisted that subset in `outputFiles`, the
same field used as the completion marker, so a retry treated the partial list as
complete and never attempted the missing file.

The permanent blackbox reproduced both failures against the real local-session
provider and child listener. Before the fix, the overlapping case observed two
database updates, and the partial case expected a rejection but close resolved
successfully after logging the failed second upload.

## Diagnosis

Archive searches for `local Claude close duplicate concurrent partial upload`,
`close session output retry swallowed upload error`, and `singleflight durable
file extraction progress` found related async-finalization and upload-retry
incidents, but no prior case for this ownership boundary.

`closeLocalClaudeCodeSession` had no operation keyed by task ID, so every caller
became an independent owner. `extractLocalFiles` caught per-file failures and
returned a plain pointer array. `outputFiles?: FilePointer[]` therefore encoded
three incompatible states in one optional value: extraction not started,
extraction in progress, and extraction complete. Once any subset was assigned,
the workflow could no longer distinguish partial progress from completion.

The deepest owned cause was a missing serialized task owner combined with a
non-durable side-effect state machine. Retriable external uploads require both a
stable object identity and an explicit completion boundary; an optional result
array cannot provide either.

## Solution

Close operations now use a task-keyed single-flight map whose entries exist only
while a close is active. Overlapping callers share the same promise, so the cost
is constant per active task and does not grow with stored agents.

Ownership metadata now persists an output-candidate record before upload,
including a stable storage object ID and an optional completed pointer. Each
successful pointer is checkpointed immediately. Upload failures propagate and
leave ownership intact; retries skip completed candidates and reuse the same
object key for the failed candidate. `outputFiles` is written only after every
candidate has a pointer, preserving it as an unambiguous completion marker.

The blackbox now passes both cases: one database close for overlapping calls,
and one upload for the already-completed file while the failed file retries at
the identical storage URL. The backend blackbox runner includes the file as the
`claude-code-local-close` domain.

## Human feedback

The user insisted the isolation work be finished, cemented, and deployed after
the prior review cycle found this blocker.

## Reusable lesson

Give every retriable side-effect workflow one keyed owner and persist per-item progress before treating its aggregate result as complete.
