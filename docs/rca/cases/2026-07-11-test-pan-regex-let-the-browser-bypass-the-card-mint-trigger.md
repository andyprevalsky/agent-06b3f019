---
id: 2026-07-11-test-pan-regex-let-the-browser-bypass-the-card-mint-trigger
date: 2026-07-11
title: A permissive sandbox-PAN regex let the browser pay with 4242… and skip the card mint the gate benchmarks were testing
surface: back-end
component: test-payment
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/test-payment/service.ts:102 — isAgentCardSandboxPan `^424242424242\d{4}$` accepts any hand-typed 4242 PAN
symptoms:
  - gate-subscription-card-mint and gate-kyc-card-mint benchmarks never raise a gate
  - browser checkout succeeds without ever calling request_payment_card
  - benchmark passes the checkout but the AttentionRequest gate is absent
tags:
  - benchmark
  - agentcard
  - gate
  - stripe
  - test-card
  - reward-hack
sources:
  - memory:project_gate_benchmarks_fe_verification
repro: agents/benchmarks/tasks.json — gate-subscription-card-mint, gate-kyc-card-mint
status: fixed
---

## Problem

Two of the four gate benchmarks — `gate-subscription-card-mint` (fixture user 102) and `gate-kyc-card-mint` (fixture user 103) — never fired their gate. The
gate logic itself was correct and wired at the real block sites
(`spawn_browser_agent_v3/handler.py:4985` for `subscription_required`, `:5042`
for `kyc_required`).

## Diagnosis

The browser agent paid with the universal Stripe test card
`4242 4242 4242 4242`, and `back-end/src/domains/test-payment/service.ts:102`
(`isAgentCardSandboxPan` = `^424242424242\d{4}$`) accepts **any** hand-typed
`4242…` PAN as a valid sandbox card. So checkout succeeded without ever calling
`request_payment_card` — and the mint _is_ the gate trigger. The benchmark had an
escape hatch that let the agent satisfy the task while skipping the exact code
path under test.

## Solution

Rewrote both task prompts in `tasks.json` to force the Rose-card path: the agent
is told it has no payment card of its own, that it MUST obtain one through
`request_payment_card`, and that it may not use any public test card. The prompts
also force a DIRECT browser spawn with no `general_purpose` middle layer. This is
a benchmark-definition change that makes the test **stricter** (anti-reward-hack),
so it was flagged to the user for confirmation rather than applied silently.

## Human feedback

The user drove the verification bar for this work: "doesnt count if i cant see
them", "i need verified links for all gates", "were these started in Chat mode?".
That insistence on a rendered, clickable FE link per gate is what exposed the two
gates that silently never fired. The user also rejected the subscription copy
"Subscribe to let Rose complete purchases" for the free-credit trigger, which must
read "Subscribe to continue this task" / "Your free credits are exhausted…"; the
default copy is correct only on the mint path.

## Reusable lesson

If an agent can satisfy a benchmark using a permissive test fixture (a public
test card, a wildcard credential), the benchmark is not testing the path it
claims — close the escape hatch in the prompt and the fixture check.
