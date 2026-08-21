---
id: 2026-08-10-eventim-empty-shell-no-payment-card
date: 2026-08-10
title: Eventim agent knew Payment Details step but deferred request_payment_card until fields mounted
surface: agents
component: spawn-browser-agent-v3
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: browser-agent reasoning — invented prerequisite that Stripe fields must mount before request_payment_card
symptoms:
  - Expected payment_approval but none triggered
  - Agent said "This is exactly the point where I should request the payment card" then deferred
  - 'Before requesting the card, I need the fields to appear'
  - Max iterations without request_payment_card
tags:
  - browser-agent
  - eventim
  - payment-card
  - agent-reasoning
sources:
  - agent 5d59430b-8c5c-4b93-98ab-da7b77a46af7
repro: none-recorded
status: wontfix
---

## Problem

Post–H-01 rerun failed with no payment_approval. Proposed empty-shell nudge was
rejected: not needed.

## Diagnosis

Agent trajectory on guest checkout after basic info:

1. Reached Payment Details headers (empty shells, 0 inputs).
2. Explicitly: "I've reached the Payment Details step. ... This is exactly the
   point where I should request the payment card."
3. Then deferred: "Before requesting the card, I need the fields to appear" /
   "without fields to enter into, I can't complete."
4. Burned remaining budget on WhiteLabel 404 / connectedStripeAccount:null /
   recoveries / other events. Never called request_payment_card. Max iterations.

Passing run 7f91554e on the same empty-shell state: "which is where I should
request the payment card" → gathered receipt → payment approval.

Cluster: **Agent Reasoning Failure** (false prerequisite). Not a missing nudge.

## Solution

No code fix. Empty-shell nudge rejected; the agent already knows to request
payment when on the card-entry step for a buy task and should not invent a
fields-must-mount prerequisite.

## Human feedback

No nudge. Agent should already know to request payment when on card-entry step
for a buy task.

## Reusable lesson

Do not add empty-shell coaching when the agent already names `request_payment_card` then invents a fields-must-mount prerequisite — treat that as agent reasoning, not a missing nudge.
