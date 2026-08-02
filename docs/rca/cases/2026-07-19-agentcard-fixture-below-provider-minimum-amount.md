---
id: 2026-07-19-agentcard-fixture-below-provider-minimum-amount
date: 2026-07-19
title: The $0.50 AgentCard lifecycle fixture was below the provider's $1.00 minimum, surfacing as a misleading missing-card-id 502
surface: harness
component: agentcard-benchmark
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: production AgentCard lifecycle fixture amount — 50 cents violates the MCP requirement `amount_cents >= 100`
symptoms:
  - AgentCard production lifecycle benchmark fails with a missing-card-id 502
  - card is never minted for the bounded lifecycle fixture
tags:
  - agentcard
  - benchmark-fixture
  - provider-minimum
  - misleading-error
  - 502
sources:
  - PR #800
repro: benchmark blackbox domain (AgentCard lifecycle amount assertions)
status: fixed
---

## Problem

The bounded production AgentCard lifecycle benchmark could never mint a card. The
observable failure was a missing-card-id 502 from the mint path, which pointed at
the card-id plumbing rather than at the request that was rejected.

## Diagnosis

The AgentCard MCP requires `amount_cents >= 100`, and the fixture requested 50
cents. The provider therefore refused to mint, and the backend surfaced the absence
of a card id as a 502 — a misleading error, because the real fault was an
out-of-contract request amount, not a broken mint response path. The fixture had
encoded a value the provider does not accept, so the benchmark was unpassable by
construction.

## Solution

Raised the production lifecycle fixture from $0.50 to the provider-required $1.00
minimum, and updated the visible checkout price plus every receipt and lifecycle
expectation consistently. The exact amount is now cemented in frontend and
benchmark blackbox tests, so a future edit that drops below the provider minimum
fails a test instead of producing an unpassable benchmark. Validation: 2,105
frontend tests passed (97 files, 2 skipped), frontend production build passed, and
the benchmark blackbox domain passed.

## Human feedback

None recorded.

## Reusable lesson

When a payment path returns a missing-resource 5xx, check the request against the
provider's documented minimums first — an out-of-contract fixture value shows up as
a downstream plumbing error.
