---
id: 2026-11-04-code-user-pause-result-omitted-session-id
date: 2026-11-04
title: A user-paused code agent's tool result was only "User paused the agent", with no code session id to resume
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/handler.py cancel branch posted message "User paused the agent" and dropped the activity's code_session facts, unlike the idle-pause result
symptoms:
  - "User paused the agent"
  - "KeyError: 'code_session'"
  - resume picked the latest session for the repo instead of the paused one
tags:
  - code-agents
  - pause
  - code-session
sources:
  - agent c4eaace9 (live repro, 2026-11-04)
  - commit 4317820584 (fix)
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py test_cc_manager_user_pause_result_names_its_resumable_code_session
status: fixed
---

## Problem

The parent planner read only "User paused the agent" for a user-paused code
agent (live repro root c4eaace9). Without a code_session_id, a resume spawn
resumes "this agent's latest session for the repo", which is the wrong session
when parallel code agents share a repo, and the text gave no sign the work was
saved and resumable.

## Diagnosis

The activity's cancelled result carries `code_session` facts
(service.py cancel return), and the idle path formats them with
`format_code_session_summary`. The handler's cancel branch never copied them.
Repro: `python scripts/run_blackbox_tests.py spawn_claude_code_agent`, pre-fix
`KeyError: 'code_session'`.

## Solution

The cancel branch copies `result.code_session` into metadata and posts
"Code session paused by the user (not failed). Its files, commits and
conversation are kept; spawn the code agent again to resume it." plus the
session summary (Code session: <id> (paused), branch …), the same facts the idle
pause reports. 10k agents: no change in calls.

Golden reference: same shape as the existing idle-pause text in
agents/domains/spawn_claude_code_agent/service.py (one wording for every pause).

## Human feedback

None recorded.

## Reusable lesson

Every resumable ending must name the handle the caller resumes with; a bare status string forces the caller to guess.
