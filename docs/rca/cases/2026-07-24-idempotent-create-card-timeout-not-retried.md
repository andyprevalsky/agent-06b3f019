---
id: 2026-07-24-idempotent-create-card-timeout-not-retried
date: 2026-07-24
title: An idempotency-keyed AgentCard create_card timeout was never retried, so the mint 502'd
surface: back-end
component: agentcard-org-mcp
classification: our-bug
problem_class: other
first_bad_boundary: the AgentCard Organization MCP provider — a create_card timeout was surfaced as a hard error even though the activity already supplied an idempotency key
symptoms:
  - "/api/purchases/mint returned 502"
  - AgentCard Organization MCP create_card times out in production
  - card mint fails on a single provider timeout with no retry
tags:
  - agentcard
  - idempotency
  - retry
  - timeout
  - prod-502
sources:
  - PR #875
repro: back-end regression coverage for the AgentCard create_card timeout retry
status: fixed
---

## Problem

Production AgentCard minting failed: `/api/purchases/mint` returned 502 after the
Organization MCP `create_card` call timed out. A single transient provider timeout
was enough to fail the whole purchase.

## Diagnosis

The calling activity already supplied an idempotency key for `create_card` — the
one precondition that makes retrying a card-creation side effect safe — but the
provider never used it: a timeout was surfaced straight to the caller as a hard
error. So the system had paid the cost of idempotency (threading a key through)
without taking any of its benefit. A timeout is also the case where the outcome is
genuinely unknown: the card may well have been created, which is exactly why the
idempotency key exists and why the correct action is to re-ask with the same key
rather than to fail.

## Solution

Retry idempotent AgentCard Organization MCP `create_card` timeouts once with the
same idempotency key, while leaving non-idempotent requests single-attempt, and
added timeout-specific error handling so a genuine failure is still reported
clearly. Regression coverage was added for the retry path. Landing the retry
behind the idempotency-key condition keeps the safety property explicit — only
requests that carry a key are retried.

## Human feedback

The record notes that `.claude/commands/deploy.md` changes in this PR were
classified as operational deploy-gate wiring and the prompt approval guard passed
with a scoped approval flag, and that AgentCard production verification is
required after merge because backend payment minting changed.

## Reusable lesson

If a request already carries an idempotency key, a timeout must be retried with
that same key — an unknown-outcome timeout on an idempotent side effect is the one
error you are allowed to retry, and failing it instead wastes the guarantee.
