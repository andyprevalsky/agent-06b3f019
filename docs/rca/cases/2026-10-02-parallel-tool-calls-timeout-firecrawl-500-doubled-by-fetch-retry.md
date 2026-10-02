---
id: 2026-10-02-parallel-tool-calls-timeout-firecrawl-500-doubled-by-fetch-retry
date: 2026-10-02
title: parallel-tool-calls timed out when Firecrawl 500s and 60s Parallel Extract fetch errors were retried, while Cerebras rate-limited the explore agents
surface: agents
component: web-fetch
classification: third-party-failure
problem_class: other
first_bad_boundary: agents/domains/web_fetch/service.py scrape_url — WebFetchProvidersFailed is retryable when either provider's error is retryable, so a Firecrawl 500 plus a definitive Parallel Extract fetch_error repeats both calls (about 63s each)
symptoms:
  - 'parallel-tool-calls: Timeout after 601s (dynamic cap=600s)'
  - "Server error '500 Internal Server Error' for url 'https://api.firecrawl.dev/v2/scrape'"
  - "Parallel Extract returned no results: [{'error_type': 'fetch_error'"
  - 'Activity failed (attempt 1/2)'
  - 'No JSON content received in Rose response'
tags:
  - web-fetch
  - firecrawl
  - parallel-extract
  - cerebras
  - explore-agent
  - smoke
sources:
  - PR #1354
  - agent ac754474-bd4f-4ca5-bbc1-41686c5cc8e5
repro: 'agent ac754474-bd4f-4ca5-bbc1-41686c5cc8e5 (deploy smoke, run 1790906410-499799-95860): worker.3.log explore activity 53 spent 126s of its 180s on two attempts of one doomed web_fetch'
status: open
---

## Problem

During the PR #1354 `/deploy` smoke lane, `parallel-tool-calls` was still ACTIVE
at its 600s cap (605s, 266 messages). Its last 25 attempts already include two
timeouts and several passes at 541-581s, so the task is heavy-tailed.

## Diagnosis

- The root agent ran three waves of explore agents. Each wave waited on its
  slowest explore, and two explores hit the 180s explore cap. All 12 explore
  activities ran on attempt 1; there were no drain or resume restarts.
- Firecrawl returned 500 on 9 of 12 scrapes in this run (0 failures in the
  previous smoke run on the same branch). Each fallback to Parallel Extract took
  about 60s and returned `fetch_error`. Because a Firecrawl 500 counts as
  retryable, the in-activity retry ran both providers again. Explore activity 53
  spent 126s of its 180s fetching `https://www.nws.noaa.gov/od/normals/` twice.
- Cerebras `qwen-3.8-27b` (rose-1-flash) returned 29 429s and 16 reasoning-only
  completions with no JSON, against 4 and 0 in the previous run. Each failed
  explore LLM call cost about 15s. The root's Claude path got
  400 `invalid_request` (exhausted Anthropic credits) and fell back to the
  waterfall.
- This branch's changes on this path are a heartbeat wrapper and import moves,
  and do not change LLM or fetch behavior.

## Solution

Open. Retrying a fetch after Parallel Extract has returned a per-URL
`fetch_error` is likely futile and doubles the cost. Whether second attempts
after a Firecrawl 500 ever succeed should be measured from prod logs before
changing the retry rule. No timeout was raised. The smoke lane was re-run.

## Human feedback

None recorded. Found while running the user-requested `/deploy` for PR #1354.

## Reusable lesson

When a fallback provider has given a definitive per-input answer, a retry
should only re-run the primary provider. Repeating the whole chain doubles the
cost of a known failure.
