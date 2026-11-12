---
id: 2026-11-11-test-prompt-asked-for-nonexistent-dated-fact-router-escalated
date: 2026-11-11
title: Latency ratchet web_search prompt asked for a dated fact that usually does not exist, so the after-search router correctly escalated some samples to an agent
surface: front-end
component: chat-lifecycle-latency semantic spec (web_search path prompt)
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/tests-e2e/chat-lifecycle-latency.spec.ts CHAT_PATHS web_search prompt — "today's Parallel Search Turbo latency announcement" premise is false on most days, and the after-search router contract (back-end/src/providers/chat/chatPrompts.ts ROUTER_AFTER_SEARCH_STEP) escalates when results lack what was asked for
symptoms:
  - "web_search sample 2 missed milestones"
  - "filter({ hasText: 'CHATWEBSEARCH"
  - "stage=after_search action=start_superintelligence reasoning=The search results do not contain a specific announcement from today"
  - "reporting that the search didn't find it is not a direct_answer; I need to escalate to plan mode"
  - web_search tool row FINISHED at ~1.3s but no canonical final answer; chat escalated to a Temporal plan agent
tags:
  - chat-router
  - semantic-latency
  - latency-ratchet
  - live-web-data
  - test-prompt
sources:
  - PR #1915
  - PR #1933
  - PR #1939
  - commit ebe427a5e97f0e24f865d5befe2564d9768bf399
  - commit d986931533e435f9372e5e104487073c4b17a0f9
  - commit fc623d61915c9cb8896ddc9468d507cffbb35cd3
  - agent 3daaf919-25a5-44d2-8b2d-58ad0c017ef6
  - agent 59e23801-1fe3-4cbf-bdc9-ad6b58b1c3e8
repro: front-end/tests-e2e/chat-lifecycle-latency.spec.ts (web_search path, semantic-latency lane); causal replay of the captured chat_router_after_search requests through createStreamingCompletion
status: fixed
---

## Problem

In the PR #1915 deploy (round 28, GitHub Actions run 43005916341 artifacts; FLAKY
occurrence 94df2671c16646b2a03733c471396977) the semantic-latency lane's
web_search case failed samples 2 and 3 of 5: the web_search tool row reached
FINISHED in about 1.3 s, but no canonical final answer containing the marker
appeared within the 15 s milestone. Its rerun passed, so the gate recorded it
FLAKY, and it was quarantined as NOT_INTRODUCED.

The backend log for that run has 12 after-search router decisions for this
prompt. Ten chose `direct_answer`. The two failing samples (agents 3daaf919,
59e23801) chose `start_superintelligence` with reasoning "The search results do
not contain a specific announcement from today (November 11, 2026) about
Parallel Search Turbo latency", then started a Temporal plan workflow. A chat
turn that escalates to an agent never renders a canonical final answer, so the
terminal milestone timed out. Both calls were served by `pool_name:
cerebras-direct`, `actual_model: qwen-3.8-27b`, `finish_reason: stop` (dump
`config`; backend `llm.cache call_site=routerLlm ... actual_model=qwen-3.8-27b`),
so no fallback host was involved.

## Diagnosis

Critical path: Enter → chat router (initial, `web_search`) → web search round
→ `chat_router_after_search` → `direct_answer` (generator writes the canonical
final answer) or `start_superintelligence` (agent workflow; no final answer).

1. Data is correct through the search: both failing samples routed to
   `web_search` and stored two TOOL results (about 5 kB each) at about 1.3 s.
2. The first bad decision is the after-search router. The captured output reads
   `"Per the rules, reporting that the search didn't find it is not a
   direct_answer; I need to escalate to plan mode to clarify with the user."`
3. That reasoning follows the contract. `ROUTER_AFTER_SEARCH_STEP` (added
   2026-10-12, bcee7f02c) says: "Do the search results contain what the user
   asked for? ... NO otherwise, route to start_superintelligence. Reporting that
   the search did not find it ... is not a direct_answer."
4. The test asked for "today's Parallel Search Turbo latency announcement". No
   such announcement exists on most days, so every after-search request asks
   the router to judge results that never contain the requested item. That
   puts the decision on a knife edge. Failing 59e23801 and passing 795e165a
   carry the same source set and total length (10,488 chars); they differ
   only in source order and excerpts. Most passing and both failing requests
   contain the same July launch, October update and November 5 articles. So
   the flip is driven by result ordering and excerpting, not by whether a
   recent dated item is present.
5. The router is also not consistent with its own rule on these inputs. In all
   10 `direct_answer` decisions it states there is no announcement from today
   and answers anyway, which a strict reading of "reporting that the search did
   not find it is not a direct_answer" would escalate. This RCA does not change
   or certify that router behavior; the fix moves the test off that boundary.
   Whether the after-search router should answer with the closest found facts
   or escalate is left as an open product question (see Solution).

Causal replay. The exact captured requests (system prompt, messages including
the search results, response schema, temperature 0, `direct-cerebras`) were
replayed through `createStreamingCompletion`, the production client:

- failing sample 2 request: `start_superintelligence` 4/4
- failing sample 3 request: `start_superintelligence` 8/8
- passing sample 1 request (different snippets): `direct_answer` 8/8
- both failing requests with only the user text changed to "Search the web for
  Parallel Search Turbo's published median latency. Include <marker> verbatim
  in the final answer.": `direct_answer` 24/24 (mixed input: the first
  router's assistant turn and search results are still the old ones)
- the initial router request with the new text: `web_search` 12/12

Receipts for a second replay set (8/8 escalate on each failing request, 8/8
answer on the passing one, 8/8 answer on each failing request with the new
text, all `qwen-3.8-27b`) and the replay script are in
`docs/handoffs/pr-1933-closeout/replay/`.

The decision is deterministic for a given request at temperature 0 and flips
with the premise, not with the model host. On this devbox, three unchanged
buggy-revision runs of the spec (18 after-search decisions) all answered: the
live results that came back there landed on the answering side of the knife
edge. The end-to-end flake depends on live data, so the reproduction is the
captured-request replay.

End-to-end proof on the fixed revision: five consecutive runs of the unchanged
command `CHAT_LIFECYCLE_PATH=web_search bash front-end/scripts/run-semantic-tests.sh
chat-lifecycle-latency` against a local `run.sh --benchmark` stack all passed.
That covered 30/30 initial `web_search` and 30/30 after-search `direct_answer`
decisions, warmups included, with the real new queries and results. Max
lifecycle was 8,415 ms (15,000 ms milestone); two samples exceeded the
6,000 ms reporting target, which is warn-only.

Deploy gate proof: PR #1933's semantic-stack gate (Blacksmith, head 907f08c6b)
ran the unquarantined spec in its latency lane. web_search passed 5/5 on the
first attempt (max lifecycle 2,415 ms), along with direct_answer, agent_plan and
agent_execute. Merged as ebe427a5e97f0e24f865d5befe2564d9768bf399.

Step 5a ladder:
- Why 1: the after-search router escalated. Cause: the results lacked what was
  asked for, which is the documented escalation contract.
- Why 2: the results lacked it because the test's premise ("today's
  announcement") is false most days. The test therefore asserts a canonical
  answer for an input whose contract-correct handling is often escalation.
- Why 3 would question the router contract itself (escalate rather than report
  "not found"). That is a deliberate product decision from 2026-10-12, so stop.
  Fix at Why 2.

The 2026-10-28 RCA on the same symptom found a different cause (a fallback host
that wrote `action` last). Its fix still holds: both failures here came from the
primary Qwen host with `action` in declared order.

## Solution

The web_search path's prompt now asks for a published fact the live results
carry ("Parallel Search Turbo's published median latency"), and the quarantine
marker is removed (the spec is restored to its pre-quarantine form plus the
prompt change). Milestones, timeouts, targets, sample counts and assertions are
unchanged. The path still exercises initial `web_search` routing, the search
round and the after-search `direct_answer` to a canonical answer. No product
code, router prompt, schema or LLM-visible harness text changed.

Sibling failures prevented: any live-data latency sample whose premise depends on
a dated event happening "today" would flip between answer and escalation from
day to day.

Residual risk: Parallel's pages phrase the figure as "p50" as well as
"median"; the fixed runs show the router treats them as the same, and every
search returned it. Open product question, not fixed here: the after-search
router applies its "not found is not a direct_answer" rule inconsistently on
near-identical results (step 5 above).

10k-agent behavior: test-only change; no runtime state, queries or channels.

Follow-up in production: after this merge, prod run 43049162124 failed one
web_search sample at the route milestone for a different cause. A Cerebras 429
led the router's fallback race to latch a GLM leg that never closed its
decision. Fixed in PR #1939 (merge 77a684dc6); see
2026-11-11-router-fallback-race-latched-first-content-not-completed-decision.
Production semantic run 43098848733 on that merge passed web_search 5/5
(max lifecycle 2,939 ms).

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded. The repair goal required keeping milestones, timeouts, targets,
assertions and permissions unchanged, and removing the quarantine marker once
fixed.

## Reusable lesson

When a live-web test sample escalates after a FINISHED search, read the
after-search router's reasoning before blaming latency. A prompt whose premise
is false (a dated event that does not exist) makes escalation the
contract-correct outcome, so ask live tests for facts the results actually carry.
