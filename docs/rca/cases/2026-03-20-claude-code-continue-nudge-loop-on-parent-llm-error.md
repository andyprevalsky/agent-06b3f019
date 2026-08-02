---
id: 2026-03-20-claude-code-continue-nudge-loop-on-parent-llm-error
date: 2026-03-20
title: Parent-LLM errors fed the Claude Code agent a "continue" nudge on every silence timeout, producing 118 identical messages
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tools/spawn_claude_code_agent.py — a failed parent LLM call fell through to the silence-timeout nudge path instead of aborting
symptoms:
  - sub-agent emits the same message over and over during a Claude Code run
  - 118 identical messages from one spawn_claude_code_agent invocation
  - "continue" written to the Claude Code stdin on every silence timeout
tags:
  - claude-code
  - sub-agent
  - infinite-loop
  - error-handling
  - stdin-nudge
sources:
  - PR #233
repro: none-recorded
status: fixed
---

## Problem

A single `spawn_claude_code_agent` run produced 118 identical messages. Every
time the harness hit its silence timeout it wrote `continue` to the Claude Code
process's stdin, and each cycle re-emitted the same message text, so the run
never converged and burned tokens on a loop that could not make progress.

## Diagnosis

The nudge path was driven by "the parent LLM said to keep going". When the
parent LLM call itself _errored_, the error was not distinguished from a normal
"keep going" decision, so the silence-timeout handler kept firing and kept
writing `continue` to stdin. A second, compounding condition: the harness
re-called the LLM even when the terminal output had not changed since the last
call, so a stalled Claude Code session generated an unbounded stream of
identical LLM calls and identical messages. The deepest owned cause is a
contract gap — the loop had no representation for "the supervising LLM failed"
and no liveness signal from the supervised process, so an error and a
no-progress state both read as permission to continue.

## Solution

`spawn_claude_code_agent.py` now returns an empty response on a parent LLM
error (so the loop stops nudging instead of retrying blindly) and detects
unchanged terminal output to skip stale LLM calls entirely. The same guard
prevents any other silence-driven nudge loop where the supervised process has
stopped producing new output. Validated against the `build-boxing-payment`
benchmark, where the sub-agent should no longer produce repeated messages.

## Human feedback

None recorded.

## Reusable lesson

A supervisory loop must treat "the supervising LLM errored" and "the supervised
process produced no new output" as explicit stop conditions — never as an
implicit instruction to nudge again.
