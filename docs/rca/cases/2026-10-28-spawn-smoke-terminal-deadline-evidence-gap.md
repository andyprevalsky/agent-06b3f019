---
id: 2026-10-28-spawn-smoke-terminal-deadline-evidence-gap
date: 2026-10-28
title: Correct population results reached completion near the spawn smoke deadline, with the causal timing boundary still unproven
surface: agents
component: spawn-agent
classification: unresolved
problem_class: other
first_bad_boundary: Unproven; measured serial source-discovery and GP research consumed the critical path before terminal status persistence near the original 480-second deadline
symptoms:
  - "Timeout after 480s (task timeout=480s)"
  - "spawn-sub-agents failed after 484.7 seconds"
  - "Firecrawl HTTP 500 followed by nested Parallel target HTTP 403"
tags:
  - spawn-sub-agents
  - research
  - timeout
  - terminal-status
  - observability-gap
sources:
  - commit e720b68fb8c1c04cd2d7dccfa6c3c095429fa829
  - benchmark run 36872151-d331-4b32-951a-67a9399c0b57
  - agent 10c3930a-5671-46c4-be26-a122dae5a491
repro: none-recorded
status: open
---

## Problem

The original native Group 4 `spawn-sub-agents` task failed with `Timeout after 480s (task timeout=480s)` and recorded duration 484.7 seconds. The canonical outer command was `bash scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-local`, invoked by `group4-ready-e720/smoke.sh` on source `e720b68fb8c1c04cd2d7dccfa6c3c095429fa829`. The catalog minimum remains 300 seconds; the unchanged native resolver selected 480 seconds using recent passing p95 424.4 seconds, n=752. Neither deadline was changed. The original full local smoke retained eight passes, this failure, and one sanctioned Claude Code credential-unavailable skip; no later pass replaces this failure.

The final root structured response contains Tokyo `14137164`, New York City `8584629`, and their exact product `121362308052156`. The FINISHED Task Complete card contains all three. The actual `dag_reasoning` request contains both city results, and the actual verifier request contains the product `121,362,308,052,156` alongside both inputs; the runtime verifier returns score 1.0. These are preserved in the captured requests and completion-card evidence. Summary prose that omits the numbers does not establish a missing-answer defect. The benchmark's declared final-answer evaluator was not executed because task execution timed out; runtime verification and correct final data do not prove a native benchmark pass.

## Diagnosis

The measured path is unchanged benchmark prompt → root planning/DAG → source-discovery Explore calls → dependent city general-purpose agents and their own Explore research → persisted city results → root multiplication/display → runtime verification/completion → status persistence → benchmark status poll.

The actual plan makes each city general-purpose agent depend on an earlier root-level source-discovery Explore. The NYC source-discovery phase ran 05:48:23.544–05:51:39.522 UTC (195.978 seconds); the dependent NYC general-purpose agent ran 05:51:51.239–05:54:56.801 UTC (185.562 seconds). This serialization is present in the captured planner output; evidence does not establish missing or corrupted planner input. The two city results reached the final reasoning input intact. Root creation was 05:47:45.349 UTC; DAG start followed 27.956 seconds later. Root multiplication completed at 05:55:11.620, display/DAG completion at 05:55:26.061, runtime verifier at 05:55:42.442, and FINISHED completion card at 05:55:47.383.

The root NYC source-discovery `web_fetch` occupied 124.590 seconds: two native attempts of 61.757 and 61.829 seconds, with Firecrawl HTTP 500 then a nested per-target Parallel HTTP 403. The child NYC Explore fetch occupied 105.700 seconds: one 61.761-second failed attempt and a second 38.001-second scrape that succeeded and was summarized. The root URL requested a 2024 Census suffix (`PST045224_34510NY`), whereas the child retried the requested 2025 table (`PST045225`) and returned 8,584,629. Parallel's 403 was a nested target error inside successful provider JSON, not an API authentication rejection. Firecrawl's response body was not retained. The existing combined retry classifier treats Firecrawl 500 as retryable; the successful same-URL child retry establishes recovery, not an ongoing provider-wide outage or proof that the retry policy should change. These measured spans cannot be added blindly because source/child work and other branches overlap.

Backend logs bracket the final status PATCH at 05:55:47.665, `updateMany` completion at 05:55:47.673, timeout-branch snapshot GET response at 05:55:48.970, and the subsequent pause saying already terminal COMPLETED at 05:55:49.018. The status PATCH HTTP response returned at 05:55:54.811. Root-relative timestamps are not the native monotonic polling clock. The producer did not retain the exact polling start/deadline or authoritative transaction commit timestamp, so these observations do not prove late polling, stale reads, a persistence race, or an on-time completion. A later COMPLETED row cannot retroactively turn the timeout into success.

Archive searches used literal `spawn-sub-agents Timeout after 484s` and behavioral `completed research correct final structured result serial fetch 500 403 deadline`, plus direct searches for spawn/timeout/serial research. The closest relative is `2026-10-01-explore-kept-researching-after-required-evidence`, including its October 16 slow-fetch follow-up. Its Solution keeps the causal/performance gap open and requires an unchanged task plus a deterministic boundary control; Human feedback records none. This occurrence does not reproduce the lost completed evidence in `2026-09-30-timed-out-explore-discarded-persisted-evidence`, whose Solution recovers task-scoped persisted research and whose Human feedback requires accessible trajectory links. It is also not the tool-count rejection in `2026-10-23-spawn-smoke-web-search-count-outlived-its-prompt`; that case has no applied solution or recorded human feedback. The current issue is a related timeout/performance gap, not a demonstrated recurrence of any one prior cause.

## Solution

None proposed or applied. This is preliminary evidence with an OPEN causal gap. No owning-boundary red → identical-command green proof, permanent causal regression, or fixed-source native task pass exists for this occurrence. No model-intelligence limitation, host-load explanation, provider outage, or timeout-policy defect is claimed. Do not change tasks, prompts, evaluators, concurrency, model routing, retry policy, or deadlines on this evidence.

The smallest useful next observation is the unchanged native task's monotonic poll start, resolved deadline, poll observations and timestamped terminal-status transaction/response, correlated with the retained actual planning inputs and source/child tool spans. A controlled owning-boundary reproduction must distinguish correct late completion from incorrect observation before a repair is justified. Root owns any later full-smoke rerun after unrelated recovery work; a pass would qualify that run but would not close this occurrence's causal gap.

The author packet remains under `.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/spawn-sub-agents-rca/`, including all original requests, native failure, task definition, actual plan, timeline, provider follow-up and scheduling samples. This draft only reads retained artifacts; it starts no tests, services, provider calls or DB queries and changes no canonical source or archive. All nine started smoke roots were published through the unchanged native evidence publisher; this failed root's publication exited 0 without changing its FAILED benchmark outcome. Exact cleanup receipt records tree sealed and root deleted.

Durable failed-run evidence: [agent trajectory](https://www.roselabs.ai/?agent-id=10c3930a-5671-46c4-be26-a122dae5a491#benchmark-share=36872151-d331-4b32-951a-67a9399c0b57.1795759817.65b0872d27b6ab91489878a8535461e79f31af96c782b15468bc8dfaec3bdfc1) and [last LLM call](https://b240d0a20f27c2dee8402ef9574f56f0.r2.cloudflarestorage.com/trace-archive/evidence/llm-dumps/10c3930a-5671-46c4-be26-a122dae5a491/last_llm_call.standalone.html?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=2fc7a1036b6c3a19df2b516c1c672dd2%2F20261028%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261028T061019Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=83720c75e8efa5ad4b1f2fe7e7f1b7a604f1d549b1a83ace65fbc9eaa57538a2). Publication receipt and hashes: `.context/deploy-fresh-20261027/group4-ready-e720/evidence/1793166205-354554-24506/receipt.json`. Links were verified by the native publisher on October 28, 2026; their signed lifetime remains finite.

## Human feedback

The user required preservation of original task assertions, deadlines and concurrency, no load/flaky explanation, and no baseline pass presented as a repair. Current delegation requires an OPEN scratch draft only; root owns source, cases, INDEX, reruns and deploy. No authorization to loosen the 480-second resolved outcome contract or claim this cause fixed was given.

## Reusable lesson

Preserve complete planning inputs and final structured results while separating correct answer content, terminal persistence, and the native monotonic deadline before diagnosing a research timeout.

## Later native qualification — October 28, 2026

On source `292537906f13e2fbbb517edeb21454fb5d710b9a`, `spawn-sub-agents` passed in 301.7 seconds. The full native smoke command passed all ten local tasks and its shared-cache fanout; the separate payment command passed all three tasks. Both commands exited 0 and verified their owned isolated cleanup. All fourteen started roots were published through the unchanged evidence publisher. [Current native trajectory](https://www.roselabs.ai/?agent-id=00980f80-16de-411d-84dd-ba33df27c9eb#benchmark-share=9ec1289c-fa8f-4e3d-9e74-7b16de473bb5.1795764807.adbc297034dedebcd66c813d30451df0dfd69a6c1304a9c2cfd91e0de1175b23).

The initial deadline boundary remains unresolved; this later qualification is not a causal repair of the original timeout. Original failures and their evidence remain unchanged; no financial return is inferred from this pass.
