---
id: 2026-11-07-spawn-create-replay-threw-on-a-stored-record-without-a-task-id
date: 2026-11-07
title: A retried code-agent spawn create threw a Prisma validation error when its stored replay record named no task
surface: back-end
component: code-sessions
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/spawn.ts replayedSpawnCreate ran findUnique with where.id = stored.session.taskId on whatever the shared ephemeral store returned; a stored create without a task id made the lookup a validation error instead of "nothing to replay"
symptoms:
  - "PrismaClientValidationError: Argument `where` of type ClaudeCodeSessionWhereUniqueInput needs at least one of `id` arguments"
  - blackbox:code-session-usage-limit failed 5 tests (retry, provider switch, duplicate concurrent retries) in the third staged backend gate and on a second local run
tags:
  - code-sessions
  - spawn-replay
  - shared-ephemeral-state
sources:
  - PR #1744
repro: back-end blackbox code-sessions case "a stored create that cannot name its task is not replayed, and the create runs" (red without the guard, green with it); `bash scripts/run-blackbox-tests.sh code-session-usage-limit` failed on its second run against the same database and now passes three runs in a row
status: fixed
---

## Problem

The usage-limit blackbox passed in the first two staged cycles and failed five tests in the third, always at the replay lookup. Gate: INTRODUCED (the replay record is this branch's idempotent create).

## Diagnosis

Replay records live in the shared ephemeral store for six hours under the spawn's lease owner. The blackbox tests reuse fixed owners such as `tool:retry:1` and their stubbed create returns no `taskId`, so the first run stores a record that cannot name its task; any later run on the same database (the staged gate reuses the worker database) finds it, the provider matches, and the unique lookup on an undefined id throws. A stored value of an older or partial shape is a normal condition for a six-hour record, so the lookup must treat it as absent.

## Solution

`replayedSpawnCreate` returns null (no replay, the create runs and overwrites the record) unless the stored record names a task id, and no longer dereferences a missing `fields`. A replay-cases regression stores such a record and asserts the create runs.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A lookup keyed from a stored record needs the same validation as input; stored state outlives the code that wrote it.
