---
id: 2026-08-04-in-activity-retry-shim-ignores-non-retryable
date: 2026-08-04
title: The in-activity retry shim ignores ApplicationError.non_retryable, so every sub-agent tool retries deterministic failures
surface: agents
component: activity-retry-shim
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/activity_helper.py — `call_temporal_activity_from_activity` retries on a blanket `except Exception` and never inspects `ApplicationError.non_retryable` or `RetryPolicy.non_retryable_error_types`
symptoms:
  - "Activity failed (attempt 1/2)"
  - "Activity failed (attempt 2/2)"
  - a deterministic tool failure logged with "retryable": false is still retried
  - duplicate paid provider calls for one tool call
tags:
  - temporal
  - retry
  - sub-agent
  - web-fetch
  - cost
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: agents/.context-repro-b2.py (scratch; to be promoted to agents/tests/blackbox/web_fetch.blackbox.py)
status: fixed
---

## Problem

In prod agent `e14d5abb`, web_fetch classified its failure as non-retryable and was
retried anyway. Both facts are in the same log window:

```
04:19:48.426  {"error": "web_fetch failed with Firecrawl and Parallel Extract...",
               "url": "https://internal/messages/+19729777432.thread",
               "retryable": false, "event": "Web fetch scrape failed"}
04:19:48.427  {"func": "web_fetch_activity", "event": "Activity failed (attempt 1/2)"}
04:19:50.452  {"func": "web_fetch_activity", "event": "Activity failed (attempt 2/2)"}
```

Four `web_fetch_activity` error spans (972 / 1022 / 1946 / 711 ms) were recorded for
two URLs: 2 Temporal attempts x 2 providers each.

## Diagnosis

`agents/domains/web_fetch/handler.py` does the right thing — it classifies the error
via `is_retryable_provider_error` and raises
`ApplicationError(..., type="WebFetchProvidersFailed", non_retryable=True)`.

The dispatcher throws that away. Explore/browser sub-agents run *inside* an activity,
so their tool calls do not go through `workflow.execute_activity`; they go through
`tagged_execute_activity` -> `agents/loop/activity_helper.py`
`call_temporal_activity_from_activity`. That shim reads only the numeric fields off
the RetryPolicy (`maximum_attempts`, `initial_interval`, `backoff_coefficient`,
`maximum_interval`) and then retries on:

```python
except Exception as e:
    last_error = e
    logger.warning(f"Activity failed (attempt {attempt + 1}/{max_attempts})", ...)
```

`non_retryable` and `non_retryable_error_types` are never consulted. On the root-agent
path the same error would stop after one attempt; inside a sub-agent it always burns
the full `maximum_attempts`.

Scope is much wider than web_fetch: every sub-agent tool call routes through this
shim, so every deterministic sub-agent tool failure costs double (or triple — the
shim's own default is `max_attempts = 3` when no policy is supplied).

Step 5a ladder:
1. Duplicate paid calls — because the activity was retried.
2. It was retried — because the shim caught a bare `Exception`.
3. The shim can do that — because it re-implements Temporal's retry semantics
   partially, honoring the numeric fields while silently dropping the classification
   fields. Evidence: `getattr(retry_policy, "maximum_attempts", 3)` with no
   corresponding read of `non_retryable_error_types`.

Rung 3 is the deepest owned cause: a partial re-implementation of a contract whose
dropped half is invisible at the call site.

## Solution

`agents/loop/activity_helper.py` now inspects the raised error before retrying:
`_is_non_retryable_error()` matches `ApplicationError.non_retryable` and
`retry_policy.non_retryable_error_types` (by `error.type`, falling back to class
name), and the `except Exception` branch re-raises immediately when it matches.
Numeric retry/backoff behavior for genuinely retryable errors is unchanged.

Cemented in `agents/tests/blackbox/activity_helper.blackbox.py` (3 tests) and
`agents/tests/blackbox/web_fetch.blackbox.py`. Pre-fix the new tests reported
`non_retryable=True was retried: ran 2x` and `non_retryable_error_types was
ignored: ran 3x`; post-fix 39/39 web-fetch tests pass and the full agents suite is
90/90.

Also fixed alongside it: `web_fetch` had NO url validation at all, so a
non-fetchable string reached Firecrawl and then Parallel Extract. `assert_fetchable_url`
now rejects anything without an http/https scheme and a real hostname before any
provider call — which, combined with the retry fix, removes all four paid calls
per hallucinated URL.

Proposed, not yet implemented. Honor the classification fields in the shim: stop
retrying when the raised error is an `ApplicationError` with `non_retryable=True`, or
when its type is in `retry_policy.non_retryable_error_types`. Preferred shape is to
make the shim's fidelity to `execute_activity` explicit and tested, so a future
divergence fails a test rather than doubling cost silently.

10k-agent behavior: strictly reduces external calls and wall clock. At the incident's
rate this alone doubled every deterministic sub-agent tool failure.

## Human feedback

None recorded.

## Reusable lesson

When a helper mimics a framework API's signature, it inherits the whole contract —
audit which fields it silently drops, because the dropped ones fail open.
