---
id: 2026-11-05-live-resume-test-read-turns-before-cli-consumed
date: 2026-11-05
title: Live-resume blackbox cases read the scripted CLI's turn record right after a delivered ack, before the CLI had read the turn
surface: back-end
component: code-sessions-live-resume-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/code-sessions-live-resume.cases.ts (cases 33/34) asserted turns(server.dir) immediately after attachLiveCodeCli returned delivered
symptoms:
  - "not ok 34 - two resumed spawns of one agent without a tool lease owner each deliver their own goal"
  - "-   'Task:\\nsecond follow-up'"
tags:
  - code-sessions
  - flaky-test
  - blackbox
  - deploy-gate
sources:
  - commit 262454efd8 (T8, introduced the cases)
  - commit 1e71a2f6b9 (backend-coverage-blackbox shard1 failure, 11 concurrent gates, MemoryHigh=11G)
repro: back-end/src/tests/blackbox/code-sessions-live-resume.cases.ts (TMPDIR=/var/tmp bash scripts/run-blackbox-tests.sh code-sessions)
status: fixed
---

## Problem

In the combined deploy gate (coverage sharded runner, shard1, heavy host load)
case 34 failed: both spawns' goals were acked `delivered` with distinct turn
ids on the same previous task (backend log), yet the scripted CLI's
`turns.jsonl` held only the first follow-up. It passed in isolation (3/3).

## Diagnosis

- Product contract: a `delivered` ack is sent from the ws-server's
  `cliChild.stdin.write` callback (e2b-templates/claude-code/ws-server.mjs
  deliverNativeTurn), i.e. the turn is in the CLI's stdin pipe
  (agents/helpers/code_session_turns.py: "written to the CLI's stream-json
  stdin"). It never claimed the CLI has read it.
- The scripted CLI records a turn when its readline consumes the line. Cases
  33/34 read that record immediately after the ack, so a CLI process not yet
  scheduled shows fewer turns. The backend log of the failing session
  (d4593612: two `delivered` acks, distinct turn ids) rules out a lost
  delivery, shared capture or dedupe: the product delivered both.
- Reproduction: CPU contention alone (24 busy loops, 6 runs) did not fail.
  Deterministic repro: the scripted CLI records follow-up turns 250 ms late
  (a descheduled CLI) → `not ok 34` with the follow-up turns missing, same
  signature as the gate.

Classification: test fixture race, not a product race.

## Solution

Cases 33 and 34 wait (bounded `until`, 15 s) for the CLI to have recorded the
turns, then assert the same exact list. The 250 ms late recording stays in the
scripted CLI, so any future read-after-ack assertion fails deterministically
instead of only on a loaded host. No product change; 10k-agent behaviour
unchanged.

## Human feedback

None recorded.

## Reusable lesson

An ack proves the hop it is sent from (here: a pipe write), not the consumer
behind it; a test that observes the consumer must wait for the consumer's own
evidence, and a fixture that is deliberately slow on that hop keeps the test honest.
