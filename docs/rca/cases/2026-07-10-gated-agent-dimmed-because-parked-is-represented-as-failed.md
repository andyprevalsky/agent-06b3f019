---
id: 2026-07-10-gated-agent-dimmed-because-parked-is-represented-as-failed
date: 2026-07-10
title: An actionable gated agent rendered dimmed because "parked on a gate" is represented as status FAILED
surface: front-end
component: agent-chat-area
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end AgentChatArea.tsx — opacity 0.8 applied whenever agentDetail.status === 'FAILED'
symptoms:
  - gate card and agent view look faded/greyed out
  - an actionable pending gate is rendered as if the agent were dead
tags:
  - front-end
  - gate
  - agent-status
  - ux
sources:
  - memory:project_gate_benchmarks_fe_verification
repro: none-recorded
status: fixed
---

## Problem

An agent parked on a pending gate rendered faded: `AgentChatArea.tsx` applied
`opacity: 0.8` to the whole view. The user was being asked to act on a gate that
the UI was simultaneously presenting as dead.

## Diagnosis

The dimming was keyed on `agentDetail.status === 'FAILED'`, and a gated agent
_does_ carry `FAILED` — that is how "parked" is represented in the lifecycle. So
one status value covers two states with opposite UI meanings: terminal failure
(dim it) and awaiting user action (make it prominent). The status field alone
cannot distinguish them.

## Solution

Dim only when `pendingGates.length === 0`, so a pending gate always renders crisp
and actionable while genuinely failed agents still fade. The general form: derive
affordance from the actionable signal (pending gates) rather than from an
overloaded lifecycle status.

## Human feedback

The user reported the faded appearance as part of insisting every gate be visible
and verifiable in the frontend ("doesnt count if i cant see them").

## Reusable lesson

Do not drive UI affordance off a lifecycle status that is overloaded — check the
actionable signal (a pending request/gate) before dimming, disabling, or hiding.
