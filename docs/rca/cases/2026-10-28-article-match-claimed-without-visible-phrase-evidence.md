---
id: 2026-10-28-article-match-claimed-without-visible-phrase-evidence
date: 2026-10-28
title: BU029 included two search results without verifying the requested phrase
surface: agents
component: browser-actor-evidence-selection
classification: unresolved
problem_class: other
first_bad_boundary: browser final answer included broad search results despite missing phrase verification; no causal model-only reproduction or owned transport defect established
symptoms:
  - polar perfect-score failed (2/3 rubrics)
  - The agent did not verify that two of its three listed articles contain value investing
  - hasPhrase False and bodyCount 0
tags:
  - polar-bu-029
  - evidence-selection
  - unsupported-completion
sources:
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - fleet run 20261028-021139-15601
  - agent da807e79-de5c-488f-b2b1-4765aff4d75c
  - fleet run 20261028-021139-15651
repro: python3 .context/rca-r8/transport-replay.py (transport audit only, no model calls or outcome proof)
status: open
---

## Problem

It7 r001-j0014, polar-bu-029 repetition one, failed C1 while C2 and C3 passed.
The task asks to search Barron's archive for articles containing “value
investing” from the last two days and list titles and publication dates. The
original 19380 task, criteria, threshold, prompt and verdict remain unchanged.
The sibling r002-j0034 passed all three rubrics but is not a controlled causal
comparison: it executed a different trajectory.

Normal shard-01 export supplied the full run/action/judge and worker logs for
both fleets. Bundle SHA256 is
adfb7796b3de66b6dc3c316fae7d20728688c2a7f77df17c24f4b160622c7938.
Original failed per-task run SHA256 is
e05e5bbef9b8881d0ac5385c252be8321c67e260c844276957e02b81fa9257f0;
sibling per-task run SHA256 is
df1d6be4430a913b12fba6cae5cce4f204434f66d8f79a611a6105bccf679f68.
All 189 extracted original files remain byte-identical after the audit.

## Diagnosis

This is a bounded read-only evidence audit, not a completed model-intelligence
RCA or a fixed harness bug. The first observed unsupported claim is the browser
final answer at trajectory step 269. It included three articles from the
keyword search, even though its own reasoning acknowledged that the search
results were not exact and that only verified articles should be included.

The decisive evidence was present in the exported trajectory and reached the
existing judge text path:

- Step 175 shows the Threadline title/date and the subscriber gate after an
  excerpt. It does not verify the requested phrase in the full article.
- Step 182 verifies the AI Selloff title containing Value Investing and its
  publication date.
- Steps 193 and 259 expose a three-item keyword-search result list and manually
  restrict the date range. A search hit alone does not verify the content.
- Step 246 contains the executed JS and its returned Energy Stocks fields:
  hasPhrase false and bodyCount zero. This proves only that the available
  articleData JSON did not establish the phrase, not that no paywalled article
  body could contain it.
- Step 269 nevertheless reports SUCCESS and includes all three titles.
- Original C1 explicitly cites steps 175, 216, 246 and 269 for this gap. C2 and
  C3 remain passed; neither was regraded or relabeled.

The sibling final answer lists only The AI Selloff Is a Chance to Shift to
Value Investing, with its October 26 date, after checking the archive and
article. Its reasoning acknowledges that paywalled content is not proven and
chooses the verified result. This supports a factual comparison of outcomes,
not a model-only success/failure separation.

The local audit executes build_polar_trajectory and run_polar_evaluator using
original messages and a stub that returns the original archived per-rubric
judgments. It asserts that every native observation and action-parameter row
survives into the full-history text supplied to all three rubric calls. Failed
run coverage is 32 observations, 76 parameter rows and 275 messages; sibling
coverage is 30 observations, 50 parameter rows and 245 messages. Reconstructed
scores remain 2/3 and 3/3 using recorded judgments, with zero model calls. This
is transport validation only and does not substitute for an exact benchmark
outcome replay or causal repair proof.

Both exports have zero embedded base64 screenshots in the stored message rows,
and the original judge records zero screenshots. External screenshot file
references exist, but those assets were not fetched. This is unverified image
coverage, not evidence that omitted pixels caused this C1 failure: the judge
already received and cited the decisive textual evidence. No broad claim of
complete image transport is made.

Archive searches: Barrons/value investing/article evidence, unsupported claim,
and article. There was no direct case for this failure. The earlier BU022
browser-action parameter persistence case is a relative; its existing action
and native-observation controls pass and this trajectory includes both types.

## Solution

No source fix is proposed or pushed. Preserve the original FAIL. No criterion,
prompt, recovery policy, retry, model or task was changed. Existing transport
controls pass 2/2; the captured audit passes without rewriting any original
artifact. An improved-model replay was not run, so model-intelligence remains
unclassified. Any future repair must first reproduce an owned failing boundary
and obtain the required exact independent review; a sibling success or static
reading alone is insufficient.

Local evidence: .context/rca-r8/compact-evidence.json contains original step
text and hashes; transport-results.json records coverage and preserved hashes;
judge-15601.json and judge-15651.json retain the original rubric decisions.
No live browser, API, provider probe or paid task was used.

## Human feedback

The parent required a thirty-minute read-only investigation at frozen 19380,
normal verified shard export only, distinction between missing transport and
unsupported actor claims, no criterion/prompt/random-retry changes and no
promotion of the original FAIL. Any protected repair requires causal red/green
and exact independent GROUNDED review before application.

## Reusable lesson

Check whether decisive negative evidence reached the actor and judge before treating an unsupported search-result inclusion as an evidence-transport defect.
