---
id: 2026-09-09-chat-web-search-excerpts-blow-lifecycle-ratchet
date: 2026-09-09
title: Chat web_search requested 10x6000-char excerpts and blew the 5s lifecycle ratchet
surface: back-end
component: back-end/src/providers/chat/chatTools.ts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/chatTools.ts::fetchParallelSearch — max_results 10 / max_chars_per_result 6000
symptoms:
  - "web_search sample 1 exceeded the full-lifecycle ratchet"
  - "Expected: < 5000"
  - "Received:   6524"
  - "chat full-lifecycle latency › web_search"
tags:
  - web-search
  - semantic-gate
  - lifecycle-ratchet
  - parallel-ai
  - excerpts
sources:
  - PR #1301
repro: back-end/src/tests/blackbox/web-search.blackbox.ts
status: fixed
---

## Problem

`/deploy` semantic `web_search` failed the 5s full-lifecycle ratchet on
every sample (p50 ~6.5–6.8s, all five 6.3–7.1s). This is not the Render
cutover flake in
`2026-07-20-semantic-ratchet-web-search-fails-inside-the-render-cutover-window`
— local Step 5, all samples over budget, not a one-off 6-12s cutover
spike.

Archive searches: `web_search sample exceeded the full-lifecycle ratchet`,
`max_chars_per_result`. Novel relative of the 2026-07-20 cutover case
(same symptom string, different cause).

## Diagnosis

1. Breakdown: router ~2s, Parallel search ~0.6s, generator ~3.7s on
   17–22KB excerpts.
2. `fetchParallelSearch` asked Parallel for `max_results: 10` and
   `max_chars_per_result: 6000`. The compose step became a document
   rewrite, not a snippet summary.
3. Fast-mode cache is DEMO-prompt only (`agentFastMode` →
   `demoCacheAllowed`), so every semantic sample is live.
4. Raising `FULL_LIFECYCLE_RATCHET_MS` would hide the payload bug.
   Owning-boundary repro: the blackbox asserts the V1 turbo body uses
   nested `advanced_settings` of 5 results / 800 chars.

## Solution

Bound turbo chat search to `max_results: 5` and
`max_chars_per_result: 800`. Cemented in
`back-end/src/tests/blackbox/web-search.blackbox.ts`. 10k-agent behavior:
smaller Parallel payload and generator tokens per chat web_search; no
shared state.

## Human feedback

None recorded.

## Reusable lesson

Do not raise a latency ratchet when the request asked a third party for
tens of kilobytes — bound the excerpt first.
