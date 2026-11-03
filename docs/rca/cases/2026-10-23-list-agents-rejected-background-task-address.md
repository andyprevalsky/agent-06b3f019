---
id: 2026-10-23-list-agents-rejected-background-task-address
date: 2026-10-23
title: list_agents on a browser/explore/code task address returned 400 with advice to message it
surface: back-end
component: agent-tree-view
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentTreeService.ts resolveNode rejected every resolved background-task address (recipient_task_id set) with 400 instead of listing that task
symptoms:
  - "Could not list agents: /root/member_number is a background task (no children); message it with send_message_to_agent"
  - "is a background task (no children); message it with send_message_to_agent"
  - "Declared evaluator assistance-declined-runtime failed: Observed tool failure: list_agents a8eb8e4a-3b75-4363-89d0-110370d9a5cd status=ERROR"
  - list_agents failed (ERROR) when an explore agent drilled into a completed browser agent
tags:
  - list-agents
  - agent-tree
  - background-tasks
  - a2a
  - browser-auth-assistance-declined
sources:
  - commit f4c70095f (introduced the 400, 2026-10-19)
  - commit dab1e6ad9 (W3: completed browser/code tasks refuse messages)
  - agent 510f5696-17dc-4b81-83fb-48f50b6d788c (root), b7b6d36c-b1af-409a-a4d5-1809dddc78dd (explore)
  - fleet run original600-1792795636260090257 (job r001-j0002, descend-full69-20261023 proof 2, source 7eb275b1b)
repro: back-end/src/tests/blackbox/agents-agent-tree.cases.ts "GET /:id/tree — node naming a background task lists that task (status, no children)"
status: fixed
---

## Problem

browser-auth-assistance-declined (job r001-j0002, 1 of 5 copies) failed its
`assistance-declined-runtime` evaluator (`no_tool_failures`) with
`Observed tool failure: list_agents a8eb8e4a-… status=ERROR`. At 23:18:15Z the
explore sub-agent b7b6d36c, asked to read the completed `/root/member_number`
browser agent's trace, called `list_agents(node="/root/member_number")` and got
`Could not list agents: /root/member_number is a background task (no children);
message it with send_message_to_agent` (cloudbench-driver.log ~4040-4130). It
then recovered via grep `trace_path`.

## Diagnosis

Path: explore `list_agents` → `explore_list_agents` → `fetch_agent_tree` →
`GET /api/agents/:id/tree?node=…` → `getAgentTreeView` → `resolveNode`.
`resolveTreeAddress` correctly resolved the path to its owner and task
(`recipient_task_id`), but `resolveNode` returned 400 for every task address
(added with the tree view in f4c70095f, 2026-10-19; an address-suite case pinned
that 400). Task nodes are already listed as leaves of their owner, so the tool
refused to show an addressable node it advertises. After W3 (dab1e6ad9),
completed browser/code tasks refuse messages, so the error's only advice also
pointed at a dead end. Deepest owned cause: the tree view's node contract did
not cover all addressable node kinds (agents and tasks), so a valid drill-down
produced an untruthful tool failure.

Local repro (agents backend blackbox domain, system PG): on 7eb275b1b the new
case fails `Expected status 200, got 400: {"error":"/root/member_number is a
background task (no children); message it with send_message_to_agent"}`
(296/297 otherwise passing).

## Solution

`resolveNode` now returns the owner row plus the task id; `getAgentTreeView`
answers a task address with `taskView`: breadcrumbs through the owner, the
task alone as a leaf (truthful status such as `completed`, no children,
no cursors). 404 if the task is no longer listed. The agents renderer already
renders this as `- /root/member_number [task of your parent] browser completed: …`
(cemented in background_agents.blackbox.py). 10k agents: no new query; the
task view reuses the owner row already read for resolution (one PK read),
constant-size response.

Outcome check: the exact unchanged task passed locally on 3788811fa
(`scripts/run-bench --local browser-auth-assistance-declined`, 184s, agent
fad726ce-b76b-42a0-9cc6-4db024de70c9), but its explore only listed `/root`, so
it did not exercise a task address. The failing path is LLM-stochastic (first
occurrence in 73 recorded attempts), so a pre-fix local failure was not
reproduced: the outcome-reproduction gap stays open; causal proof is the
blackbox red/green.

Evaluator note: `no_tool_failures` stays a truthful gate once the tool stops
erroring; removing it from this task (as Andy did for four sibling
browser-auth tasks) is a separate benchmark-definition decision.

## Human feedback

None recorded.

## Reusable lesson

Every address a tree/listing tool advertises must be listable by that tool with its truthful status; never answer a valid drill-down with an error that redirects to another tool.
