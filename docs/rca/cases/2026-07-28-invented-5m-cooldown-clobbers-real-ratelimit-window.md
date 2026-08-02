---
id: 2026-07-28-invented-5m-cooldown-clobbers-real-ratelimit-window
date: 2026-07-28
title: The TS backend never read Anthropic's rate-limit reset headers, so a synthetic 5-minute cooldown clobbered the real 7-day window
surface: back-end
component: rose-client
classification: our-bug
problem_class: other
first_bad_boundary: RoseRateLimitError — carried only (message, status), discarding retry-after and never reading anthropic-ratelimit-*-reset
symptoms:
  - 500 "No Claude Code credentials available"
  - '"Your credit balance is too low" while a valid synced Max OAuth token exists in the row'
  - an exhausted token re-served every 5 minutes
  - "rate-limited until 2026-07-28T17:00:06Z (invented +5m) overwriting 2026-07-30T22:00:00Z"
tags:
  - rose
  - rate-limit
  - anthropic
  - claude-code
  - credentials
sources:
  - commit 69cb82790
  - memory:project_claude_code_ratelimit_window_clobber
repro: none-recorded
status: fixed
---

## Problem

Prod, 2026-07-28, user `1f85ff25`: the Claude Code path returned 500
"No Claude Code credentials available" / "Your credit balance is too low" even
though a valid synced Max OAuth token was sitting in the credential row. The two
cooldown writers disagreed 15 seconds apart:

```
16:54:51  rate-limited until 2026-07-30T22:00:00Z   <- Python, real 7d reset
16:55:06  rate-limited until 2026-07-28T17:00:06Z   <- TS, invented +5m
```

## Diagnosis

The TS backend never read `anthropic-ratelimit-*-reset`. On a 429 it used
`retry-after` for the in-request sleep and then discarded it, because
`RoseRateLimitError` carried only `(message, status)`. With no timing to pass,
`markComputeTokenUnavailable` substituted a synthetic 5 minutes. The Python agent
path (`agents/providers/rose/claude_auth.py`) DOES read those headers, so the
**uninformed writer clobbered the informed one**. The exhausted token was then
re-served every 5 minutes; and while it was flagged, the Claude Code path found no
credential, fell through to the unfunded shared `ANTHROPIC_API_KEY`, and 500'd. The
deepest owned cause is that a cooldown window was allowed to be _shortened_ by a
writer that had no rate-limit information.

## Solution

New `providers/rose/rateLimitReset.ts` ports `_extract_rate_limited_until`: reset
headers → ISO/epoch/duration scraped from the body → `retry-after`.
`RoseRateLimitError` now carries `rateLimitedUntil`; `claudeAuth.ts` and both 429
sites in `gptAuth.ts` populate it; `computeRotation.ts` threads it into
`markComputeTokenUnavailable(token, reason, rateLimitedUntil)`. Also ports Python's
`_should_rotate_429_without_retry` (a >60s reset is a usage window → rotate
immediately rather than burn in-place retries) and its backoff jitter. Backoff
windows are made **monotonic** (`notAlreadyBackedOffLonger`) so a synthetic cooldown
can only extend a window, never shorten one. `parseHttpDate` is deliberately strict
because `Date.parse('42')` returns year 2042, which as a credential cooldown would
be a 16-year lockout.

## Human feedback

The user's standing position that a provider-billing block is not a code block was
applied here: `/deploy` no longer stops to ask when a code-review provider is out of
credits, since that gate is provider-blocked and the agent cannot fix user-owned
billing.

## Reusable lesson

When two code paths write the same cooldown, make the window monotonic and derive it
from the provider's own reset headers — an uninformed synthetic backoff will
otherwise shorten and destroy the real one.
