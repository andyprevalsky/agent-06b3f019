---
id: 2026-10-03-evidence-publisher-held-claude-code-tasks-to-browser-recording-rule
date: 2026-10-03
title: The evidence publisher treated a Claude Code task as a browser task and failed its FE link for a missing browser recording
surface: harness
component: evidence-publisher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/publish_evidence_links.py validate_browser_agents_terminated_with_recording classified any task row with action_type task_started/task_complete as browser-related regardless of toolName, so spawn_claude_code_agent tasks needed a browser recording
symptoms:
  - "FE link browser validation failed:"
  - "browser task 2e9897f8-3fe2-43a6-8f70-5cac6ff3c310 has no correctly attached recording (need reachable recording_view_url or fetchable recording_file_pointer)"
tags:
  - evidence
  - deploy
  - claude-code
  - fe-link
sources:
  - PR #1401
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

After the deploy Step 6 local smoke passed 12/12, verifying each task's durable FE link with `scripts/publish_evidence_links.py` failed for `claude-code-agent` (agent `70a95432-8cf2-497d-b9f5-0ea02551ac13`) with `browser task 2e9897f8-3fe2-43a6-8f70-5cac6ff3c310 has no correctly attached recording`. The agent never spawned a browser.

## Diagnosis

The archived transcript for that agent has three rows for task `2e9897f8`, all with `toolName=spawn_claude_code_agent`: `claude_code_started`, `task_started`, and `task_complete`. The validator marked a row browser-related when `toolName == "spawn_browser_agent"` **or** its `action_type` was in a browser action set that includes `task_started` and `task_complete`. Claude Code tasks reuse those two action types, so every Claude Code agent failed the browser recording rule and could never be published as evidence. Real browser rows in the same smoke run (`browser-smoke`, `agent-payment-test-shop`) all carry `toolName=spawn_browser_agent`.

Local repro: a new case in `publish_evidence_links_browser_validation.test.sh` feeds the three Claude Code rows. On the old publisher it fails with `['browser task cc1 has no correctly attached recording ...']`; with the fix it passes.

## Solution

- An action-type match now counts as browser-related only when the row has no `toolName` (legacy rows). Rows from any other named task tool are ignored, while `spawn_browser_agent` rows are still always checked.
- The test also pins that a legacy browser row without `toolName` still has to terminate. It runs in the deploy structural gates via `scripts/run-deploy-structural-gates.py`.
- No product or runtime change, and no 10,000-agent impact: the change is confined to an offline evidence script.

## Human feedback

None recorded.

## Reusable lesson

A classifier that keys on shared event names must scope them to the emitting tool, or every new tool that reuses a lifecycle name inherits rules meant for another one.
