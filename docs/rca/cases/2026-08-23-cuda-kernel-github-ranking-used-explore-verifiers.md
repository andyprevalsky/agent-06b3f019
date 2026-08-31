---
id: 2026-08-23-cuda-kernel-github-ranking-used-explore-verifiers
date: 2026-08-23
title: CUDA GitHub top-100 plan used parallel explore verifiers instead of one coding agent
surface: agents
component: planner-prompts
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/utils/prompts.py build_planner_system_prompt decomposition rules — classified GitHub star ranking as spawn_explore_agent + reasoning work instead of spawn_code_agent programmatic API fetch
symptoms:
  - "Cost limit reached: 1020.2c >= 1000c (own 107.8c + children 912.4c)"
  - spawn_agent explore fan-out for "top 100 repos on github" CUDA kernel ranking
  - plannedToolName spawn_explore_agent on deduplicated ranking task
  - reasoning verifier task for exact-100 GitHub repo audit instead of spawn_code_agent
  - b775556c-e2be-4c61-99b1-81c5af7d5490
tags:
  - planner
  - spawn-explore-agent
  - spawn-code-agent
  - github
  - cuda
  - cost-limit
sources:
  - agent b775556c-e2be-4c61-99b1-81c5af7d5490
repro: agents/tests/blackbox/prompt_invariants.blackbox.py::test_planner_routes_programmatic_public_api_ranking_to_code_agent
status: fixed
---

## Problem

Agent `b775556c-e2be-4c61-99b1-81c5af7d5490` was asked for the top 100 GitHub repos
where people develop CUDA or CUDA-adjacent kernels. The planner decomposed the goal
into seven parallel `spawn_explore_agent` tracks (five category scouts, one
explore-based ranking step, one `reasoning` audit verifier). Execution spawned 38
explore agents, 84 `web_search` calls, zero `spawn_claude_code_agent` calls, and hit
`COST_LIMIT_REACHED` at 1020c (children 912.4c) before returning the structured
`repos` list.

FE: https://roselabs.ai/?agent-id=b775556c-e2be-4c61-99b1-81c5af7d5490

## Diagnosis

Critical path: user goal → PLAN decomposition LLM → DAG tasks 1-7 → explore
fan-out + web_search loops → cost blow-up → COST_LIMIT_REACHED.

The spawn_agent tool prompt already documents cost order `explore << code` and says
to use the cheapest capable agent, but the planner decomposition prompt mandated
"information retrieval" via `spawn_explore_agent` and told planners to use
`reasoning` for "pure analysis, synthesis." GitHub star ranking/deduplication is
programmatic public-metadata work (GitHub API or scripted fetch), not exploratory
web research. Misrouting it to five parallel explore scouts plus a reasoning
verifier is O(parallel agents × web searches) instead of one coding-agent API pass.

First-bad boundary: `build_planner_system_prompt` decomposition invariants and alias
table — not the explore agents themselves.

## Solution

1. Planner prompt (`agents/utils/prompts.py`): explicit rule that programmatic
   public API ranking/dedup/formatting must use `spawn_code_agent`, not explore or
   reasoning; example structure for programmatic API ranking; alias table clarifies
   reasoning is not for rank/dedup work a coding agent can run.
2. Main agent system prompt: align with spawn_agent cost order; warn that explore
   fan-out for large list aggregation is high energy vs one coding agent.
3. Benchmark `cuda-kernel-github-top100-code-agent` in `tasks.json` with the
   natural prod user prompt (no tool-routing instructions in the goal text —
   that would be reward hacking) and harness-side `expected_tool_counts` /
   `forbidden_tools` / evaluators for `spawn_claude_code_agent`.
4. Regression test
   `test_planner_routes_programmatic_public_api_ranking_to_code_agent`.

10k-agent behavior: one coding-agent API pass per ranking task is O(1) agent spawn
vs O(categories) explore trees; no cross-agent verifier fan-in on the root DAG.

## Human feedback

User asked to turn agent b775556c into a benchmark and RCA why the harness did not
use the more energy-efficient coding-agent path for the final ranking instead of
spreading independent verifiers. Later rejected stuffing "use spawn_claude_code_agent
exactly once / at most 2 explores" into the task prompt as reward hacking — routing
must come from planner invariants, judged by harness tool-count checks.

## Reusable lesson

When a goal is programmatic public API ranking or deduplication, plan
spawn_code_agent — not parallel explore agents or reasoning verifiers.
