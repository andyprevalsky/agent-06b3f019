---
id: 2026-08-03-start-agent-test-launched-competing-chat-escalation
date: 2026-08-03
title: The start-agent route test launched a competing chat escalation, so its own fixture could reach agent mode first
surface: back-end
component: agents-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/agents-configuration.cases.ts used createTestAgent for a pre-escalation route contract even though that helper starts an asynchronous chat handler
symptoms:
  - "POST /:id/start-agent — happy path (no Temporal)"
  - "Expected 200 or 500 for start-agent, got 400"
  - "Agent is already in agent mode"
tags:
  - blackbox
  - fixture
  - agent-mode
  - race
sources:
  - PR #924
repro: back-end/src/tests/blackbox/agents-configuration.cases.ts
status: fixed
---

## Problem

The backend coverage gate passed all 108 unit files but failed one agents
blackbox route case: `POST /:id/start-agent — happy path (no Temporal)` received
400 where the case expected 200 or a Temporal-unavailable 500. The server
returned the request in 83 ms after reading the agent row, so the failure was
not a slow endpoint or a request timeout.

## Diagnosis

The case created its input with `createTestAgent`. That shared helper explicitly
creates a chat-mode root and starts chat handling in the background without
waiting for it. Under the loaded parallel gate, setup lasted long enough for
that owned background path to escalate the row and set `temporalWorkflowId`
before the case sent its own `/start-agent` request. The route then correctly
returned its documented `Agent is already in agent mode` 400.

The first bad boundary was the fixture contract: a test of the pre-escalation
transition used a helper that concurrently performs the same transition.

## Solution

The route case now writes the precise pre-escalation Agent and Verifier rows in
one nested Prisma create, with no background chat handler and no partial
two-write fixture if a transient database failure is retried. The original
strict 200-or-500 assertion remains, so an unexpected 400 is not normalized
away. Cleanup still uses the suite's tracked-agent path. This is one
agent-scoped atomic fixture write in test code only: it adds zero production
runtime work or fan-in, including at 10,000 concurrent production runs.

## Human feedback

None recorded.

## Reusable lesson

Build state-transition fixtures at the exact pre-transition boundary; never use a helper that asynchronously performs the transition under test.
