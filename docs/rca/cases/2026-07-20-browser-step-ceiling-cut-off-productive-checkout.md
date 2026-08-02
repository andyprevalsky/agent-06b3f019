---
id: 2026-07-20-browser-step-ceiling-cut-off-productive-checkout
date: 2026-07-20
title: The 30-step browser budget terminated agents that were still making forward progress through checkout
surface: agents
component: browser-agent
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: the browser agent MAX_ITERATIONS ceiling — the handler returned max_iterations right after a successful step-30 action
symptoms:
  - browser task terminates at the 30-step ceiling mid-checkout
  - handler returns max_iterations immediately after a successful action
  - multiple browser tasks in one agent all end at the step ceiling
tags:
  - browser-agent
  - step-budget
  - checkout
  - max-iterations
  - production-capture
sources:
  - PR #825
repro: the unchanged browser boundary regression (fails at MAX_ITERATIONS=30, passes at 50)
status: fixed
---

## Problem

Production agent `62734899-ddd8-472a-a8b2-ddef79c74e44` started nine browser
tasks and consumed 250 observed browser iterations; six of those tasks
explicitly terminated at the 30-step ceiling. The captures show the boundary
steps were _productive_: the agent clicked "Continue to Payment" and entered the
checkout contact number at step 30, and the handler then returned
`max_iterations` before another observation or action could happen.

## Diagnosis

The hard step budget of 30 was below the true step count of a real multi-page
checkout flow. Evidence distinguishes this from the usual "agent is looping"
reading of a step-ceiling hit: the final actions at the boundary advanced the
flow rather than repeating, and the terminal state fired one step after a
successful action. So the ceiling was cutting off healthy work, not stopping a
runaway. The record establishes this from production captures first, then
confirms it with an unchanged boundary regression that fails at
`MAX_ITERATIONS=30` and passes at `MAX_ITERATIONS=50` — the budget is the only
variable.

## Solution

Raised the browser agent hard step budget from 30 to 50 and added a regression
tied to the production captures that were still advancing checkout at step 30.
The existing max-step best-effort terminal behavior is preserved at the new
boundary, so the change moves the limit without weakening what happens when it is
genuinely reached. Gates: browser blackbox `spawn-browser-agent-v3` 1 passed,
agents coverage across the full 85-domain suite at the 80% threshold, and the
agent-behavior guard reporting no recovery/terminal semantic edits.

## Human feedback

None recorded.

## Reusable lesson

Before treating a step/iteration ceiling as either a bug or a limit to raise,
read the captures at the boundary — repeated actions mean a loop to fix, while a
successful forward action one step before termination means the budget itself is
wrong.
