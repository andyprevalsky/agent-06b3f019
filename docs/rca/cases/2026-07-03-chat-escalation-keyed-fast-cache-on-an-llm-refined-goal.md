---
id: 2026-07-03-chat-escalation-keyed-fast-cache-on-an-llm-refined-goal
date: 2026-07-03
title: Chat escalation started the workflow with an LLM-refined goal, so every chat-originated run got a fresh empty fast-cache namespace
surface: agents
component: fast-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/chat/chatHandler.ts — "Use refined goal if provided" starts Temporal with a goal that differs from the persisted Agent row
symptoms:
  - 100% fast-cache miss on plan/execute/verifier/summary for chat-originated prod runs
  - "llm.cache.miss goal-hash segment does not match sha256(agent.goal)[:16]"
  - DAG calls hit the cache while the same run's main-loop calls miss
tags:
  - fast-cache
  - cache-key
  - chat
  - temporal
  - cost
sources:
  - memory:project_fastcache_chat_goal_namespace
repro: agents/tests/blackbox/workflow.blackbox.py — wf_fast_cache_goal_uses_persisted_row
status: fixed
---

## Problem

Chat-escalated production agents never reused Fast Mode cache: plan, execute,
verifier, and summary calls missed 100% of the time, run after run, while DAG
calls in the _same_ run hit. Fast Mode namespaces by exact goal hash
(`normalize.goal_hash`, no normalization), so a differing goal means a brand-new
empty namespace.

## Diagnosis

`chatHandler.ts` ("Use refined goal if provided") starts the Temporal workflow
with an **LLM-refined** goal, which differs from the goal persisted on the Agent
row and varies run to run. Every chat-originated run therefore keyed into a fresh
namespace. DAG calls hit because `ensure_position_context` resolves the DB-row
goal instead of the workflow argument — which is exactly the discrepancy that
localized the bug.

Message normalization was never the issue: content fingerprints were
byte-identical across runs, and only the goal segment of the key diverged.

## Solution

`agents/helpers/fast_cache_goal.py` added `resolve_fast_cache_goal_activity`,
which resolves the persisted Agent-row goal at workflow start;
`self.fast_cache_goal` then threads into every keying site — `run_agent`
`goal_text`, verifier/summary/schema `fast_mode_goal`, web-executor kwargs, and
the compute-token affinity key. Regression test:
`wf_fast_cache_goal_uses_persisted_row` in
`agents/tests/blackbox/workflow.blackbox.py`. Residual, recorded as still open:
sub-agent goals embed the wall-clock date ("Today's date is …"), so a parent that
goes live on a new day re-keys its whole subtree.

## Human feedback

None recorded.

## Reusable lesson

When debugging fast-cache misses, compare the goal-hash segment of
`llm.cache.miss` keys against `sha256(agent.goal)[:16]` — a mismatch means some
path threaded a non-persisted goal, and cache keys must always derive from
persisted state, never from a run-local LLM rewrite.
