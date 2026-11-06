---
id: 2026-11-06-web-fetch-provider-chain-exceeds-activity-timeout
date: 2026-11-06
title: One web_fetch call held an explore agent 394s because sequential provider/download work exceeded its 180s activity timeout and the timeout was retried
surface: agents
component: web-fetch
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: agents/domains/web_fetch/service.py scrape_url + config.py — Firecrawl httpx timeout 120s then Parallel Extract timeout 120s run inside a 180s start_to_close activity (handler.py) with RetryPolicy(maximum_attempts=2), so a hung page times out the activity and the retry repeats the whole chain
symptoms:
  - "Timeout after 553s (task timeout=549s)"
  - "Activity timed out after 180.0s"
  - "Web fetch failed for https://www.visitlisboa.com/en/regions"
  - "Time Elapsed: 6m 33s"
tags:
  - web-fetch
  - firecrawl
  - parallel-extract
  - activity-timeout
  - explore-agent
  - smoke
  - parallel-tool-calls
sources:
  - PR #1725 deploy (failed source 2731bfe53, originating merge d5d852e5b)
  - agent f6899445-88bc-4b28-890a-75aed858d46c (Benchmark Hub run 20261106-105813-889402-mfa70829f6947)
repro: agents/tests/blackbox/web_fetch.blackbox.py test_hung_providers_fail_within_the_scrape_budget_and_are_not_retried and test_hung_file_downloads_return_inside_the_download_budget (domain web-fetch)
status: fixed
---

## Problem

`parallel-tool-calls` failed at its 549s task timeout, agent still ACTIVE. Hub
message timestamps (root thread, run 20261106-105813) show the critical path:
root spawned Austin/Denver/Lisbon explores at 11:08:17; Austin and Denver
finished by 11:09:55; root then waited on `/root/lisbon_research` from
11:10:00 to 11:15:15. The Lisbon explore had fired
`web_fetch https://www.visitlisboa.com/en/regions` at 11:08:28 (its three
sibling fetches finished in 2-9s); that one call returned the tool error
`Activity timed out after 180.0s` ... `Time Elapsed 6m 33s` at 11:15:02 (394s).
The explore then finished in 13s. The root's final synthesis (109s LLM call) and
completion verifier ran 11:15:15-11:17:09 and the cap hit at 549s. Same task passed
twice earlier in the deploy (1699.9s wall and 924.8s wall under fleet load).

## Diagnosis

`web_fetch_activity` runs `scrape_url`: Firecrawl (httpx timeout 120s), and on
failure Parallel Extract (httpx timeout 120s). The activity is scheduled with
`start_to_close_timeout=180s` and `RetryPolicy(maximum_attempts=2)`
(handler.py). Worst case of the chain is 240s > 180s, so a page that hangs both
providers ends as an activity timeout (not a typed provider error), and the
retry policy runs the chain again: 2 x 180s + backoff = the observed 393s.
The message text comes from the in-process retry shim
`loop/activity_helper.py` (explore agents call activities through it): it treats
`asyncio.TimeoutError` as retryable and the error is its `Activity timed out after
180.0s`. Which activity timed out is not observable (no worker logs). Two sites share
the defect: `web_fetch_activity` (scrape chain 240s worst case) and
`web_fetch_download_activity` (sequential per-file httpx timeouts of 30s per phase, no
total bound, same 180s x 2 attempts). The 394s = 2 x 180s + 1s backoff + ~33s; that
residual fits a normal scrape + Haiku summarize followed by a hung download at least
as well as a hung scrape, so both are fixed. An independent read-only review
(managed thread ph71qgdjy3qhqwey3vymg0te0x8hq07t) reached the same ambiguity.
Everything else in the trace was healthy (parallel siblings fetched in seconds,
web_search sub-second), so the loop was not blocked. Earlier archived cases show
the same shape: 2026-10-16 (Denver NOAA PDF: two attempts of ~105s each, Firecrawl
500 then Parallel no-results) and 2026-10-02 (retry doubled the chain). Those cases
recorded the retry cost but not that the chain budget exceeds the activity budget;
this is the recurrence that makes the invariant violation explicit.
Worker logs of the cloud guest are not retained (no ClickHouse rows for the agent
id), so the exact timed-out function is inferred, not observed. Open observability
gap: the shim's `Activity timeout (attempt n/2) func=` warning is not retained for
cloud guests.

## Solution

`domains/web_fetch/config.py`: Firecrawl cap 90s + Parallel Extract cap 60s,
`WEB_FETCH_SCRAPE_BUDGET_SECONDS` = their sum (150s), and the activity timeout is a
named constant (180s) used by the handler. `scrape_url` bounds each provider call by
`asyncio.wait_for` against one shared deadline, and when both providers hang
(`ProviderHung` or httpx timeouts) the `WebFetchProvidersFailed` is non-retryable, so
the agent receives a typed tool error in <=150s and picks another URL instead of the
activity retrying a hung page. Other failure classes keep their retry behavior.
`download_files_batch` gets the same shape: one 120s budget across the sequential
downloads (`wait_for` against the shared deadline; remaining files are skipped, best
effort as before) so the download activity returns instead of timing out and retrying.
Regressions (web-fetch blackbox domain, already part of deploy): hung stubs return a
typed non-retryable error inside a scaled budget (fails before the fix: never
returns), and the real provider chain must be shorter than the activity timeout that
the handler actually schedules. No task timeout, definition or assertion changed.
10k-agent behavior: per-call bounded work, no shared state; a hung page now holds one
agent's tool call for <=150s instead of 393s.

Outcome proof: the exact task is externally dependent and heavy-tailed; a local run
cannot be forced to hit a hung page, so the unchanged-task fail-before/pass-after pair
is an open outcome-reproduction gap. The fixed revision's task result is recorded in
the deploy report.

## Human feedback

None recorded.

## Reusable lesson

The sum of an activity's sequential provider timeouts must be shorter than its
start_to_close timeout, and a hang must not be retried as if transient; otherwise
the activity timeout hides the typed error and the retry multiplies the stall.
