---
id: 2026-09-03-claude-oauth-authorize-dom-value-captured-as-code
date: 2026-09-03
title: Claude callback extraction accepted untrusted page values as OAuth codes
surface: back-end
component: compute-grants Claude browser OAuth watcher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/claudeGrantMint.ts READ_CODE DOM fallback ran before the Anthropic manual callback page loaded
symptoms:
  - "exchange failed 400: {\"error\": \"invalid_grant\", \"error_description\": \"Invalid 'code' in request.\"}"
  - connect.watch_failed
  - Claude connection remained pending until the 10-minute browser TTL
tags:
  - claude
  - oauth
  - compute-grants
  - invalid-grant
  - callback-capture
sources:
  - commit c9f74b2728daca74b2dd8d79aadac45a973eaa0d
repro: cd back-end && node --import tsx src/tests/blackbox/compute-claude-oauth.blackbox.ts
status: fixed
---

## Problem

Two production Claude connection attempts on 2026-09-03 reached
`claude.ai/oauth/authorize`, then failed four to six seconds later at token
exchange with `invalid_grant` and `Invalid 'code' in request.` A Codex
connection completed through the same browser, seeding, and persistence
infrastructure. The failed Claude browser sessions were released only at their
10-minute TTL rather than when exchange failed.

## Diagnosis

The Claude watcher obtains its exchange input only from the browser-evaluated
`READ_CODE` script. Production telemetry proves that this path reached exchange
and Anthropic rejected its input, but it did not record the capture source or
page metadata, so it does not directly prove which DOM value was submitted.
The best-supported inference is the locally reproduced first-bad boundary:
`READ_CODE` gated query-string codes to a callback-looking path, while its
`input[value], code, pre` fallback ran on every page and accepted any long
URL-safe string, with or without embedded OAuth state. The unchanged local
contract test captured both an authorize-page decoy and a lookalike-origin
value on the buggy revision. The same trace also proved the watcher catch only
logged exchange failure; it did not mark the session failed or release its
browser, so polling and billing continued until TTL.

## Solution

Gate every Claude code extraction path on the exact
`https://platform.claude.com/oauth/code/callback` origin and path, preserve state
from query callbacks, require rendered manual codes to include their `#state`
suffix, and compare that state with the initiating session before exchange.
After capture or minting starts, watcher failures now become terminal poll
results and release the remote browser immediately; pre-capture CDP read
failures remain retryable. Cancellation and watcher teardown share one
idempotent release path. Architecturally the change adds no timer, query, or
shared fan-in per connection; terminal failures release capacity sooner. This
is a scaling assessment, not a measured 10,000-session load result.

## Human feedback

None recorded.

## Reusable lesson

Treat browser-scraped OAuth material as valid only after the exact registered
callback boundary is proven; never infer an authorization code from a generic
DOM value on an authorize or login page.
