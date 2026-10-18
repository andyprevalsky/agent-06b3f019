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

### October 16 cc65 city-research timeout: slow fetch and repeated selection

A later unchanged `parallel-tool-calls` attempt at source
cc65de6809344b97fd0c8b08767f470f431b5c42, run
037a3d17-b7b0-442b-a65d-25cb6f5e56c6, agent
38257983-e729-49bf-8f94-6cd9df56a2c4 failed with ACTIVE rather than COMPLETED.
Native duration was 365.4 seconds; the poll reported Timeout after 359s with
effective task timeout 356s. The normal resolver retained the catalog's 300s
minimum and extended it using recent passing p95 158.0s, n=646, multiplied by
2.25 and rounded up. No definition, evaluator, model, provider pin, timeout,
retry count or budget changed. This is a task failure, not an infrastructure
exclusion or a successful result inferred from partial findings.

This occurrence differs from the original five-wave research trace. The root
GPT-6 Sol response launched one medium Explore per city concurrently at
13:57:32Z. Austin completed in 23.983s and Lisbon in 46.522s. Denver remained
on the critical path until benchmark cancellation: its parent tool span was
352.604s and worker activity 362.238s including cancellation drain. Its main
model calls selected qwen-3.8-27b. Those are logical model/provider observations,
not a claim that one provider or model universally caused the outcome.

At 13:58:43Z Denver selected the NOAA Colorado normals PDF at
https://www.ncdc.noaa.gov/climatenormals/clim20supp1/states/CO.pdf.
The web_fetch dispatch consumed 212.131s: scrape attempts of 104.927s and
106.198s with the normal one-second retry interval. Each attempt observed
Firecrawl HTTP 500, then Parallel Extract returned no results with a target
HTTP 503 entry. The error reached the tool result. The actual stored next
request, 1792159335364-15c15eb65aa9-explore_agent.json (18 messages), includes
that failure; the model explicitly reasons that the PDF failed 503 and chooses
to retry it alongside a new web search. That response took 2.341s. The new
fetch ran another 77.059s before cancellation. An earlier unrelated WRCC page
also had a captured certificate-hostname mismatch. No conclusion about the
remote origin's deeper failure is supported by these transport observations.

The trace does not establish an owned invariant violation. Three spawns were
parallel, two children completed, the slow fetch returned typed errors through
its two configured attempts, the error remained in the next model context,
and the medium child retained its normal 600s parent/activity bound. The
benchmark's shorter independent 356s outcome budget expired first. Existing
Firecrawl 500/Parallel 503 retry classification and fallback sequencing explain
the measured path; changing them merely to clear this task would change an
existing policy without a causal defect proof. The root never reached final
synthesis while awaiting Denver. Partial city findings do not satisfy the
COMPLETED assertion.

All 31 local model input/output dumps (1,754,098 bytes), worker/backend logs,
raw run/task data and original automatic diagnostics were preserved privately
under `.context/parallel382-RCA/`. The exact final Denver dump preserves full
messages, tools, generation settings, candidate routing and output. No live
model replay was performed or authorized; no old/new model separation was
proved. A source-only contract inspection is not a deterministic failing
owning-boundary test, and no runtime repair or fixed task outcome is claimed.

The prescribed local diagnostic commands were started in parallel from the
original owned preflight agents checkout. Agent latency used the saved worker
log, explicit local FE base http://localhost:56200 and
--no-record-span-history; it completed. Agent logs used --tree --diagnostics
--url http://localhost:56200 and failed with ConnectError because the normal
stack had already retired. The original run's automatic agent_logs diagnostic
had succeeded before teardown and remains available. Its later PAUSED status
reflects benchmark cleanup, not the status at the timeout. The post-run latency
trace extends through cleanup and must not replace the native 365.4s benchmark result
duration, which includes finalization. No production endpoint was queried and no database or
stack was recreated.

The deeper cause remains open. Falsifiers requiring further evidence include
an actual error omitted from a reconstructed model request, unintended
serialization or timer drift, a non-retryable response incorrectly classified
under the declared provider contract, or a controlled unchanged request replay
that separates a concrete client defect from model choice. The captured request
already falsifies lost-error-context as an explanation for the second PDF
selection. Provider 500/503 responses alone do not prove a general provider
outage, and variable model research is not a proved intelligence limitation.
An eventual unchanged full smoke pass would establish that run's qualification
only; it would not fix or waive this failure. No new test, suppression, prompt,
task definition or runtime source change accompanies this archive addition.

## Human feedback

None recorded.

## Reusable lesson

Separate slow model research decisions from tool and service latency with the exact child request, tool timeline, and a controlled replay before changing Explore limits or prompts.
