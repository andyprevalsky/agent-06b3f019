---
id: 2026-07-24-leading-slash-command-bypassed-claude-model-turn
date: 2026-07-24
title: A leading uppercase /RCA prompt was parsed as an unknown slash command before Claude received a turn
surface: infra
component: auto-rca
classification: configuration-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Claude Code prompt entry — a prompt beginning with /RCA entered case-sensitive slash-command parsing
symptoms:
  - "Unknown command: /RCA"
  - Auto-RCA investigator returns num_turns 0
  - native Claude Code installs correctly but the investigation never begins
tags:
  - auto-rca
  - claude-code
  - slash-command
  - prompt-routing
  - zero-turn
sources:
  - PR #879
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production run 30063795346 installed native Claude Code, but both investigators
returned `Unknown command: /RCA` and `num_turns: 0`. The newly added zero-turn
invariant correctly blocked reproduction and deployment.

## Diagnosis

Claude Code interpreted a prompt whose first token was `/RCA` as an interactive,
case-sensitive slash command. The orchestrator intended it as natural-language
instruction, so parsing consumed the prompt before the model received any turn.

## Solution

Keep the prompt on one line but prefix it with `Run`, producing
`Run /RCA on production agent <agent-id>`. This routes the text through a real
model turn while preserving the requested workflow.

## Human feedback

None recorded.

## Reusable lesson

When invoking a slash workflow programmatically, wrap it in an explicit
natural-language instruction so the client does not consume it as UI syntax.
