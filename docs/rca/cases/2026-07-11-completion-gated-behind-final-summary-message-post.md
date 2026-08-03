---
id: 2026-07-11-completion-gated-behind-final-summary-message-post
date: 2026-07-11
title: Agents were marked finished only after the non-critical completion_summary message insert, so a slow insert left verified agents durably ACTIVE
surface: agents
component: temporal-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py — completion persistence ran after the final `completion_summary` message post instead of before it
symptoms:
  - smoke tasks `message-person` and `spawn-sub-agents` fail on timeout
  - already-verified agent stays durably ACTIVE until the smoke timeout
  - completion_summary message insertion lags behind agent verification
tags:
  - temporal
  - workflow
  - agent-status
  - completion-summary
  - smoke
  - ordering
sources:
  - PR #739
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

Two smoke tasks — `message-person` and `spawn-sub-agents` — failed on timeout
even though both agents had already been verified as done. Their rows stayed
`ACTIVE` in the database for the whole remaining smoke budget, so the harness
kept waiting on agents that had finished their actual work.

## Diagnosis

Both failures shared one cause: `agents/workflows/agent_workflow.py` only marked
an agent finished _after_ posting the final `completion_summary` message. That
message is a UI nicety, not part of the completion contract, but it sat on the
critical path — so any slowness in inserting it (or any failure of that insert)
left an already-verified agent durably `ACTIVE`. The deeper flaw is ordering: a
non-critical presentation write was allowed to gate the authoritative lifecycle
transition that every consumer (smoke harness, frontend, parent agents) polls.

## Solution

Persist agent completion _before_ the non-critical final summary UI post, so the
authoritative status transition can never be delayed or lost by a presentation
write. Landed in `agents/workflows/agent_workflow.py` and cemented by a workflow
ordering regression in `agents/tests/blackbox/workflow.blackbox.py`, which runs
in the agents blackbox suite. The same ordering rule protects every other
lifecycle consumer, not just smoke: any observer that waits on terminal status
now sees it as soon as the work is verified.

## Human feedback

None recorded.

## Reusable lesson

Never gate an authoritative lifecycle state transition behind a non-critical
presentation write — persist terminal status first, then post the UI message.
