---
id: 2026-08-26-doordash-food-plan-stale-cart-goal-paraphrase
date: 2026-08-26
title: DoorDash food-plan benchmark checkout reused stale server cart and dropped harness goal
surface: cross
component: spawn-browser-agent-v3 / benchmark-run_benchmark
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SpawnBrowserAgentManagerV3.execute_tool — spawn_browser_agent.goal paraphrased the root manifest goal and omitted BENCHMARK EXECUTION CONTRACT before browser_activity_wait
symptoms:
  - browser-doordash-food-plan-grocery-order Declared evaluator doordash-food-plan-cart-completeness failed
  - 47 items in cart checkout without adding manifest lines
  - spawn_browser_agent task_started missing BENCHMARK EXECUTION CONTRACT
  - run.sh exited early with code 125 docker overlay mount invalid argument
tags:
  - doordash
  - food-plan
  - benchmark
  - spawn-browser-agent
  - stale-cart
  - manifest
  - write-lock
sources:
  - agent 263d5568-541b-418c-94f5-e24531421001
  - agent f9702ff9-5f91-4d13-b649-5fce225ccad3
  - relative 2026-08-22-write-lock-rejected-never-closed-browser-status-chip
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_spawn_goal_preserves_benchmark_food_plan_contract; scripts/run-bench --local browser-doordash-food-plan-grocery-order (outcome gate, still failing on cart completeness)
status: open
---

## Problem

`browser-doordash-food-plan-grocery-order` failed after manifest-exact judging shipped.
Two coupled failures:

1. **Harness goal drop (fixed):** Root agent received the full prod execute prompt plus
   `BENCHMARK EXECUTION CONTRACT`, but `spawn_browser_agent` was started with a paraphrased
   goal missing the contract and cart-clear instructions (`agent 263d5568`, 194s). The
   browser rushed checkout with only seven clicks and no `input_text`/`evaluate` cart building.

2. **Stale server-side cart (open):** Authenticated DoorDash sessions retain a large Safeway
   cart on the account. Even after the goal passthrough fix (`agent f9702ff9`, 270s), the
   browser opened a pre-existing **47-item** cart, did not clear it, and the manifest-exact
   judge scored 0.0 for missing lines and skipped cart-clear evidence.

Cloud rerun also hit **Docker overlay mount EINVAL** when isolated benchmarks tried to
create Postgres; `ROSE_USE_SYSTEM_PG=true` is required on this VM.

## Diagnosis

**Archive searches:** `doordash food plan manifest cart completeness`; `browser-doordash-food-plan premature checkout Kodiak`. **Relative** to `2026-08-22-write-lock-rejected-never-closed-browser-status-chip` Issue 2 (premature checkout / no cart completeness gate), not a FE chip recurrence.

**Critical path:** benchmark goal → execute-phase root LLM → `spawn_browser_agent.goal` → browser loop → DoorDash cart → write-lock → manifest LLM judge.

| Evidence | Run | Finding |
| -------- | --- | ------- |
| Root USER goal | 263d5568 | Contains `SAFEWAY MANIFEST` + `BENCHMARK EXECUTION CONTRACT` (4051 chars) |
| Browser `task_started` | 263d5568 | Paraphrased goal; **no** contract marker; 23 browser actions, 0 `input_text` |
| Browser `task_started` | f9702ff9 (post-fix) | Full 4404-char parent goal with contract + cart-clear text |
| Browser actions | f9702ff9 | Still no cart-clear; `evaluate` showed only 3 lines; judge failed cart-clear criterion |
| Prior passing loose judge | 701d60d4 | 37 grounded SKUs; strict judge scores 0.0 (missing Valentina, broccoli, etc.) |

**First-bad boundary (harness, fixed):** `SpawnBrowserAgentManagerV3.execute_tool` trusted
`tool_call.goal` instead of the parent workflow goal when the benchmark contract marker was present.

**Remaining boundary (open):** browser agent execution loop does not clear server-side carts or
rebuild the full manifest before checkout — model-intelligence / missing deterministic gate.

## Solution

**Shipped (harness):**

1. `_browser_spawn_goal_from_parent` passes the root goal verbatim when it contains
   `BENCHMARK EXECUTION CONTRACT` and `SAFEWAY MANIFEST`.
2. Extended contract: empty stale Safeway cart + full cart evaluate before checkout.
3. Isolated Linux benchmark stacks default `ROSE_USE_SYSTEM_PG=true` in `local.py`.
4. Manifest-exact evaluator + supplemental cart evidence (prior commit).

**Tests:** `test_browser_spawn_goal_preserves_benchmark_food_plan_contract` (causal repro for goal drop).

**Not yet shipped:** deterministic cart-clear automation or write-lock preflight against the
manifest table. Benchmark outcome gate still red after harness fix.

**10k-agent behavior:** Goal passthrough is O(1) string check per spawn; no new fan-in.

## Human feedback

User required pass only when cart items match the prompted manifest exactly, not broad cart counts.

## Reusable lesson

When a benchmark embeds instructions in the root goal, never trust the execute-phase LLM to
forward them in spawn_browser_agent.goal — pass the parent goal verbatim for marked contracts,
and treat authenticated ecommerce carts as server-side state that must be cleared before manifest builds.
