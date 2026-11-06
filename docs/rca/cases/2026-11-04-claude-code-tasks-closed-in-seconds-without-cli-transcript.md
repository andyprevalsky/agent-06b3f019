---
id: 2026-11-04-claude-code-tasks-closed-in-seconds-without-cli-transcript
date: 2026-11-04
title: Paused code sessions lack cliSessionId because their only task closed in 3-5 s before the CLI wrote a transcript
surface: back-end
component: code-session-checkpoint
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: undetermined. Checkpoint capture (checkpoint.ts cliSessionIdFromLog) is correct; the CLI never wrote ~/.claude/projects/*.jsonl in these sandboxes
symptoms:
  - CodeSession cliSessionId NULL with latestCheckpointSeq > 0
  - checkpoint manifest cliLogPath null, cliSessionId null, artifacts only worktree.tar.gz
  - resume cannot claude --resume; starts a fresh conversation
  - claude-code-agent ClaudeCodeSession closed after 3-5 s with closeReason close and no output
tags:
  - code-sessions
  - cli-session-id
  - smoke
  - claude-code
sources:
  - benchmark run claude-code-agent smoke on prod (read-only queries and R2 manifests, 2026-11-04)
repro: none (open)
status: open
---

## Problem

In prod (read-only, 2026-11-04), 64 of 72 claude PAUSED sessions that have a
checkpoint had a NULL `cliSessionId`, so a resume could not `--resume`.

## Diagnosis

The capture path is not at fault. Every PAUSED session whose task ran longer than
30 s has a `cliSessionId` (claude 7/7, codex 7/7). All 79 sessions without one
(64 claude, 15 codex) have a single task that closed 3-5 s after creation, with
`closeReason=close`, `claudeTokenSource=anthropic`, no output, and goals from the
`claude-code-agent` smoke benchmark. Their checkpoint manifests (R2, read-only)
show `cliLogPath: null`: no `*.jsonl` existed under `~/.claude/projects` at close.
The CLI therefore never wrote a transcript, so there was no conversation to
resume. A smoke agent observed the same day shows the tool finishing in about
10 s, followed by `[Agent → Codex]`, which looks like a provider switch after a
failed Claude start.

Open gap: why these Claude CLI runs end within seconds and close as `close`
rather than `failure` or `usage_limit`. That needs the sandbox ws-server and CLI
stderr for one such task, which is not retained. This is outside T3's lifecycle
scope; it was reported to the parent.

## Solution

None. Recorded so the missing `cliSessionId` is not re-diagnosed as a capture bug.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Before blaming session-id capture, check whether the CLI ran long enough to write a transcript; correlate missing ids with task duration and the checkpoint manifest's cliLogPath.
