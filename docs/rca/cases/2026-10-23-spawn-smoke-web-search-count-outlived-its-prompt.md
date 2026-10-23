---
id: 2026-10-23-spawn-smoke-web-search-count-outlived-its-prompt
date: 2026-10-23
title: spawn-sub-agents still requires web_search >= 2 after its prompt stopped requiring web_search, so Opus general-purpose agents that hand explore official URLs fail a valid direct-fetch trajectory
surface: harness
component: benchmark-task-contract
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json spawn-sub-agents min_tool_counts.web_search=2 (added in b55ccd828 when the prompt said "MUST use direct web_search only"); the current prompt (9c2be652a) only says "should use explore-agent web research" and "Use official sources"
symptoms:
  - "Tool 'web_search': expected at least 2 call(s), got 1"
  - "Tool 'web_search': expected at least 2 call(s), got 0"
  - spawn-sub-agents explore agents call web_fetch on toukei.metro.tokyo.lg.jp / census.gov QuickFacts without web_search
tags:
  - spawn-sub-agents
  - evaluator
  - min-tool-counts
  - descend-full69-20261023
sources:
  - fleet run original600-1792738962466034914
  - agent 30434b44-597c-4413-81e6-dcc986cd04af
  - agent b7fde12e-2311-4083-9c30-2fdf47962e3a
  - agent b515f914-2b68-4e58-bc8f-35a886ec91e8
  - commit b55ccd828
  - commit 9c2be652a
repro: none — approval-gated contract decision; evidence is the cross-run trajectory table below
status: open
---

## Problem

In run 2 of descend-full69-20261023, three of the five spawn-sub-agents copies
failed on `web_search` count 1 (j0007, j0016, j0034). Run 1 passed 2/2.

Neither K5 nor K9 caused this:

- **K5:** no autoscaled worker became ready in any copy (worker-ready.ids is
  empty).
- **K9:** K9 does remove api_request from the explore toolset (Cerebras
  toolset of 8 tools became 7). But api_request was never called in run 1, and
  a run-2 copy with the 7-tool set still searched 5 times.

## Diagnosis

The failures follow the model of the general-purpose agent. Run 1's Claude
lease was rate limited until 03:10Z ("Marked compute token rate-limited"), so
its general-purpose agents ran on gpt-6-sol. In run 2 the lease worked, so most
general-purpose agents ran on claude-opus-5-5.

Explore goals written by gpt-6-sol general-purpose agents contained 0 URLs in
6 of 6 cases. Goals written by Opus agents embedded 2-5 official URLs in 8 of
8 cases. The explore agent (qwen-3.8-27b) then fetched those URLs directly.

Web_search counts by the model of the Tokyo general-purpose agent:

| Tokyo general-purpose agent | web_search counts |
| --- | --- |
| GPT | 5, 5, 5 |
| Opus | 1, 1, 4, 1 |

The NYC explore agent rarely searches (0-1).

**Contract history:**

| Commit | Date | Prompt wording | web_search count |
| --- | --- | --- | --- |
| b55ccd828 | 2026-05-14 | "Each general-purpose agent MUST use direct web_search only" | min 2 added (one per child) |
| 83ffadb60 | — | Moved to "should use explore-agent web research" | Count retained |
| 9c2be652a | 2026-09-30 | Added dated official sources | Count retained |

So the current task prompt never asks for web_search, while the evaluator still
does. Fetching the official table directly is consistent with the current
prompt. This classification has not been proven by a model-only replay; the
evidence is the cross-run table above.

## Solution

None applied. This is an approval-gated task-contract decision for Andy: either
restore web_search wording to the prompt or drop or replace the count. Neither
was implemented (rule 25).

## Human feedback

None recorded.

## Reusable lesson

When a tool-count evaluator fails, diff it against the task prompt's own history before treating the agent's behaviour as the defect.
