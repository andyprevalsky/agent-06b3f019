---
id: 2026-10-21-codex-native-terminal-monitor-never-completes
date: 2026-10-21
title: Native Codex app-server completed its turn but the parent monitor waited for process exit
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service.py _run_agentic_loop ignored turn_ended with raw_type turn/completed and treated a persistent app-server as a one-shot process
symptoms:
  - Native turn_ended and final arrived but the parent still reported working
  - Codex completed-turn count stayed zero after a native terminal event
tags:
  - codex
  - app-server
  - completion
  - lifecycle
  - code-agent
sources:
  - agent b1ae7be4-b534-45c9-ad87-7972e4138b2b
  - task 443148cd-6b98-47f5-8554-742f671d880d
  - plan:sandbox iku38svp0lb6qg04tk9el
  - plan:/home/boxes/rose-ui/sem/logs/worker-resume-20261021.log
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py test_native_codex_terminal_event_finishes_idle_app_server
status: open
---

## Problem

The original game run received native Codex `turn_ended` then `final` at
2026-10-21 00:05:19 UTC. Its parent still emitted working observations at
00:05:46, 00:06:16, 00:06:46 and 00:07:16. The app-server intentionally remained
alive to accept future turns. Cleanup and private-stack shutdown were verified
by the parent before source edits.

## Diagnosis

Path: Codex app-server `turn/completed` → ws-server normalized `turn_ended` →
`ClaudeCodeWsClient.on_event` → `_run_agentic_loop` → code-tool result.

The consumer recognized legacy `turn.completed` and `type=turn` completion,
while its exit-grace code recognized Claude `type=result`. Neither accepted the
native `turn_ended` event. The most upstream bad boundary was the consumer's
terminal contract, not the successful provider response. A native app-server
has no expected process exit between turns, so only adding legacy exit grace
would also preserve an unnecessary wait and return an unknown exit result.

Archive searches: literal `turn.completed|Post-result exit grace|native.*terminal`
and behavioral `parent.*hang|session.*never.*complet|monitor.*complet` in
`docs/rca/cases/`. No matching Codex app-server consumer case was found. This is
a new producer-consumer mismatch introduced with native transport.

## Local reproduction

Executed `/home/boxes/rose/agents/venv/bin/python /tmp/run-native-codex-repro.py`.
The driver invokes the permanent blackbox functions directly through `runpy`.
The fake WS sends the exact native lifecycle shape, then leaves its connection
open. Before the fix the unchanged completed-turn assertion timed out:
`asyncio.wait_for(service._run_agentic_loop(...), timeout=1.0): TimeoutError`.
Logs: `/tmp/native-codex-before.log` and `/tmp/native-codex-after.log`.
The matcher independently returned False for this exact native event shape.

## Solution

The monitor now uses an authoritative native terminal outcome as the logical
attachment result: completed → 0; failed/interrupted → 1. It does not wait for
the persistent app-server process to exit. A newer `turn_started` or a user
turn with a different native ID invalidates the previous terminal state. A
held direct-chat session remains attached until released. Replay rebuilds the
state. Completed-turn deduplication uses native turn IDs; duplicate terminal
representations cannot inflate the count. Legacy Claude SDK grace is unchanged.

The identical reproduction now passes completed, failed and interrupted cases,
plus direct-hold and newer-turn preservation. Permanent tests are registered in
the `spawn-claude-code-agent` blackbox domain, run by the agent coverage/deploy
path. Native session-cumulative usage logs also preserve `usage_scope` instead
of losing that qualifier. No prompt, timeout, evaluator or acceptance change.

## Remaining outcome verification

The original game rerun is owned by the UI lane. This case remains open until
that unchanged live outcome is verified; local boundary regressions establish
the consumer repair, not the game outcome. No paid rerun was performed here.

## Human feedback

Keep the original game outcome separate from a proxy regression. Preserve
active steering, user-held sessions and genuine native terminal outcomes. Stop
the exact owned private stack before source edits; do not retry paid runs here.

## Reusable lesson

A persistent agent process has a different completion boundary from its turns.
Test its new normalized lifecycle through the real consumer with the process
still alive, including later turns and direct-user holds. Preserve cumulative
usage scope across telemetry boundaries.
