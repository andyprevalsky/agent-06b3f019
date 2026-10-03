---
id: 2026-10-01-explore-kept-researching-after-required-evidence
date: 2026-10-01
title: Parallel city research exceeded smoke cap after five Explore waves
surface: agents
component: spawn-agent
classification: unresolved
problem_class: other
first_bad_boundary: Unproven; earliest observed candidate is root LLM choosing source validation after initial city summaries at 00:58:44 UTC
symptoms:
  - "Timeout after 605s (dynamic cap=600s)"
  - "parallel-tool-calls failed after 643s while agent was ACTIVE"
  - "Cancelling explore agent after parent wait budget"
tags:
  - explore-agent
  - benchmark
  - research
  - timeout
sources:
  - agent c61081ca-7fb4-4775-b1eb-3f7226bffed8
  - benchmark run 3bc264f6-8b89-4b46-b7fe-6048df42127f
  - task parallel-tool-calls
repro: none-recorded
status: open
---

## Problem

The unchanged local Pre-Deploy `parallel-tool-calls` task exceeded its 600-second dynamic cap. The runner marked it failed after a 605-second status check, although the agent continued and completed shortly afterward. The agent's wall clock was 655.8 seconds, with a 638.5-second `run_agent` span. The task asks for cost of living, neighborhoods, and weather for Austin, Denver, and Lisbon, with one Explore sub-agent per city. It does not require an exact annual precipitation value. The final Denver Explore goal, written by the root agent, asked for July high and annual snowfall, with annual precipitation **if easy**.

The root agent launched nine Explore calls in five waves. The first three ran in parallel for 64.6, 90.8, and 100.0 seconds. The later calls took 71.3; 48.3 and 150.8 in parallel; 38.9 and 76.7 in parallel; then 150.7 seconds. The critical path through those waves was about 550 seconds before root reasoning, initialization, and completion verification. The initial city summaries arrived by 00:58:35 UTC. At 00:58:44 the root chose to validate data sources and launched further Explore calls. That choice had stated reasons: some first-wave cost and climate figures were contradictory or weakly sourced. The last Denver child had official July and snowfall evidence by 01:04:56. It first searched for optional precipitation at 01:05:04, then at 01:05:22 stated it had the core data and searched further. The parent cancelled it at its normal 150-second wait boundary at 01:06:43. The root attempted completion at 01:06:53, about 617 seconds after start.

## Diagnosis

The request path was benchmark prompt → root `execute_loop` LLM → parallel `spawn_agent` calls → Explore LLM and `web_search`/`web_fetch` → persisted tool evidence → root completion and verifier → benchmark status poll. The earliest candidate boundary was the root's choice to begin further source validation after the first three city summaries. The trace does not establish that this choice was wrong: the root identified real contradictions and source concerns. The final Denver child's optional precipitation search is a later example of critical-path amplification after the requested July and snowfall facts were present. Two Explore calls exhausted the 150-second parent wait and returned raw persisted research rather than a final child synthesis; this is a related evidence-quality limit, not the old generic empty result fixed in `2026-09-30-timed-out-explore-discarded-persisted-evidence`.

The span waterfall showed no comparable service bottleneck: backend HTTP p95 was 26 ms, final Explore activity queue wait was 9 ms, `web_search` p95 was 625 ms, and the slowest `web_fetch` was 16.4 seconds. The long wall clock came from repeated LLM research turns and five dependent waves. The existing Explore system prompt already says to stop once the request can be answered and to report gaps after a couple of attempts. A further prompt instruction has no evidence of fixing this class.

The archived exact Explore requests were replayed with unchanged messages and tool schemas using `scripts/replicate_llm_dump.py`. At the checkpoint after July/snowfall evidence (8 messages), flash/Qwen and ultra/GPT-6 Sol both requested more weather searches. At 16 messages, flash/Qwen called `attempt_completion_with_result` in replay while ultra/GPT-6 Sol requested four more searches; the original flash run had continued. Thus the captured call demonstrates variable tool choice, not a controlled old-model/new-model separation. No model change is justified. Archive searches for `parallel-tool-calls spawn_agent 63 timeout` and `high tool count repeated spawn_agent agent loop` found related cases, including the September 30 evidence-loss case, but this run did not reproduce its generic empty-result boundary.

The Step 4 classification remains **unresolved** and the Step 5a bucket remains **other** while open. Repeated research turns are observed, but the stricter model-intelligence-limitation proof requires a reproducible old/new model separation that these replays did not show. No first-bad causal boundary or owned code defect has been established. A finer bucket candidate is bounded research termination when required evidence is present but optional source precision remains unresolved.

## Solution

No runtime, prompt, benchmark definition, timeout, or test limit was changed. The isolated stack logs, exact agent response, and replay inputs/results are saved under `.context/rca-parallel-tool-calls/` in this workspace. The exact failed suite run was observed locally; there is no deterministic owning-boundary regression test that fails on the buggy code and passes after a fix, and no fixed-revision `scripts/run-bench --local parallel-tool-calls` pass. This RCA remains open. Before calling it fixed, establish that deterministic boundary proof, run the unchanged exact task before and after the repair, and record both FE-visible runs. A rerun that happens to pass does not prove a repair.

## Human feedback

None recorded.

## Reusable lesson

Separate slow model research decisions from tool and service latency with the exact child request, tool timeline, and a controlled replay before changing Explore limits or prompts.
