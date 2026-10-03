---
id: 2026-10-03-evidence-verifier-treated-claude-code-task-as-browser
date: 2026-10-03
title: The durable-evidence verifier counted a Claude Code task as a browser task and failed it for having no recording
surface: harness
component: evidence-links
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/publish_evidence_links.py `validate_browser_agents_terminated_with_recording` treated any row with a generic lifecycle action (`task_started`, `task_complete`) as browser progress, whichever tool emitted it
symptoms:
  - "browser task 00760a98-d839-4e65-9b93-d5894cdd564c has no correctly attached recording (need reachable recording_view_url or fetchable recording_file_pointer)"
  - "publish_evidence_links.py fails for every claude-code-agent smoke run"
tags:
  - evidence-links
  - claude-code
  - deploy-gate
sources:
  - PR #1341
  - agent cc17aa8d-3084-4b0c-b5bb-90ab382735fe
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh feeds a `spawn_claude_code_agent` task with `task_started` and `task_complete` rows; before the fix it reports a missing browser recording, after the fix it passes. A lifecycle row with no tool name still counts as browser progress.
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, publishing durable evidence for
the smoke `claude-code-agent` (`cc17aa8d-3084-4b0c-b5bb-90ab382735fe`) failed.
The verifier reported that task `00760a98` had no browser recording. That task
was the agent's Claude Code session, which never opens a browser.

## Diagnosis

### Evidence

- The run record holds three rows for task `00760a98`. All three have
  `toolName=spawn_claude_code_agent`, with actions `claude_code_started`,
  `task_started`, and `task_complete`.
- Browser tasks in the same run (`browser-smoke`) tag every progress row
  `toolName=spawn_browser_agent`.
- The verifier's predicate was
  `tool_name == "spawn_browser_agent" or action in {..., "task_started", "task_complete"}`.
  The second clause matched the Claude Code rows.

### Root cause

`task_started` and `task_complete` are lifecycle actions that every spawn tool
emits. The verifier read them as browser-specific, so any agent that ran Claude
Code failed the recording check.

## Solution

Rows that name another tool are no longer browser progress. Rows tagged
`spawn_browser_agent` still are, and so are rows with no tool name whose action
is a browser lifecycle action. The regression test covers a Claude Code task
(passes) and a lifecycle row with no tool name (still requires a recording).
Rerunning the publisher for `cc17aa8d` reports `verified in fresh browser (18 msgs)`.

## Human feedback

None recorded.

## Reusable lesson

When a check keys on shared lifecycle events, scope it by the emitter first.
Generic actions like "started" and "complete" say nothing about which subsystem
produced them.
