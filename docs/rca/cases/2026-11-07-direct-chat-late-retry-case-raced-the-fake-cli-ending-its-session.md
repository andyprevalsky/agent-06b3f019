---
id: 2026-11-07-direct-chat-late-retry-case-raced-the-fake-cli-ending-its-session
date: 2026-11-07
title: A direct-chat blackbox case sent its late duplicate retry after the fake CLI could already have ended the session
surface: agents
component: code-session-direct-chat
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/tests/blackbox/code_session_direct_chat.blackbox.py agent_turns_before_the_cli_has_its_task_are_queued_and_follow_it_in_order_once waited for the replay CLI to log three stdin lines and then sent a late retry expecting "duplicate", while the fast replay CLI finishes and the server ends the session on its own clock
symptoms:
  - "TurnDelivery(status='rejected', turn_id='a-1', reason='session_ended', attempts=1)"
  - agents-coverage-blackbox failed 1 of 127 domains (code-session-direct-chat, 19 passed 1 failed) in the staged cycle on bbaf81e02
tags:
  - direct-chat
  - fake-cli
  - load-flake
sources:
  - PR #1744
repro: agents `python scripts/run_blackbox_tests.py code-session-direct-chat` passed 8 of 8 on a quiet host and failed in the gate under host load; the case now holds the fake CLI's first turn (gate_first_turn), waits for the server to report both queued turns delivered, sends the late retry while the session is certainly alive, then releases the CLI (6 of 6 green)
status: fixed
---

## Problem

One new case of this branch failed in the staged agents coverage gate with the late retry refused as `session_ended`. Gate: INTRODUCED (new test).

## Diagnosis

After the queue flush the replay CLI replays its recorded turns and exits when stdin closes, and the server then ends the session. The case observed the three CLI stdin lines, which only proves delivery, and only then sent the retry; on a loaded host the CLI finished and the session ended in between. Holding the CLI on its first turn is not enough on its own: a held CLI reads only its first line, so the case must wait for the server's own `user_turn` events (the flush) instead of the CLI's log.

## Solution

The sandbox starts with `gate_first_turn`; the case waits for two `user_turn` events, asserts the late retry is `duplicate`, then releases the first turn and checks the CLI's stdin lines, the single write and the exit.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A status that only exists while a session lives must be asserted while something is holding the session alive, not after a timing assumption.
