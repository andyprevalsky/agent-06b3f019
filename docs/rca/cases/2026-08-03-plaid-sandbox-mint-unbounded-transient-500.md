---
id: 2026-08-03-plaid-sandbox-mint-unbounded-transient-500
date: 2026-08-03
title: A transient Plaid Sandbox token-mint 500 occupied the blackbox gate for three minutes because the external fixture call had no deadline or retry
surface: harness
component: plaid-blackbox
classification: third-party-failure
problem_class: other
first_bad_boundary: back-end/src/tests/blackbox/plaid.blackbox.ts mintSandboxPublicToken called the external Plaid Sandbox once with the SDK's unbounded default request timeout
symptoms:
  - "exchange: idempotent across distinct mints -- Request failed with status code 500"
  - Plaid blackbox case duration exceeded 181000ms with no matching backend HTTP span
tags:
  - plaid
  - sandbox
  - blackbox
  - external-fixture
  - retry
sources:
  - PR #924
repro: back-end/src/tests/blackbox/plaid.blackbox.ts under the canonical backend test:coverage gate
status: fixed
---

## Problem

The canonical backend gate passed 114 of 115 blackbox domains, but the Plaid
domain failed `exchange: idempotent across distinct mints` after 181.657 seconds
with `Request failed with status code 500`. The preceding real Sandbox exchange
completed successfully, and later Plaid exchanges also completed in roughly one
second, making the failure a transient external-fixture error rather than a
credential or route-wide outage.

## Diagnosis

The failed case creates an anonymous backend session and then calls
`mintSandboxPublicToken` directly against Plaid before calling the Rose exchange
route. `coverage/server.log` contains the anonymous-session request but no
`/api/integrations/plaid/exchange-public-token` span for the 181-second failure
window; the test caught the Plaid SDK's Axios-style 500 text directly. Therefore
the request never entered our backend. The first owned weakness was the harness
boundary: this disposable Sandbox fixture call used the SDK's default unbounded
timeout and had no retry policy, so one provider 500 consumed three minutes and
failed an otherwise healthy product contract gate.

The closest missing problem-class bucket is
`external-provider-fixture-resilience`; `other` is used until that taxonomy
exists.

## Solution

The Plaid blackbox client now caps Sandbox fixture calls at 30 seconds and mints
tokens through the canonical `retryWithBackoff` helper. It retries only transient
provider statuses (429 and 5xx) and network timeout/reset codes, for at most
three attempts with bounded delays; credential and validation errors still fail
immediately. The mint is not idempotent: an ambiguous successful attempt can
leave an extra Sandbox Item. That disposable test-only side effect is explicitly
tolerated here and must not be generalized to production writes. This does not
change production or 10,000-agent behavior. It makes the external dependency
bounded and preserves the live-Sandbox coverage instead of weakening the test
to a mock.

## Human feedback

None recorded.

## Reusable lesson

Every live-provider fixture used by a deploy gate needs a bounded deadline; add
a narrow retry only when its repeat semantics explicitly tolerate ambiguous
successes and duplicate side effects.
