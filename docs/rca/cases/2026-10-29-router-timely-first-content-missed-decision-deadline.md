---
id: 2026-10-29-router-timely-first-content-missed-decision-deadline
date: 2026-10-29
title: Timely first content did not produce a router decision within the attempt deadline
surface: back-end
component: chat-router-live-failover
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: first router attempt reached15000ms with103chunks and1026JSON chars but no actionable decision; missing response bytes prevent deeper causal classification
symptoms:
  - the live GLM failover must serve inside the first router attempt's bounds
  - Completion deadline expired without a decision
  - Transient structured-output miss; regenerating
sources:
  - PR #1627
  - commit d7e67eb38c3b21c5cd912c340c29e301e483f0e8
  - plan:/var/tmp/deploy-1627/d7e67-chat-router-rca/report.md
tags:
  - router
  - live-failover
  - deadline
  - observability
repro: node /var/tmp/deploy-1627/d7e67-chat-router-rca/probe.cjs
status: open
---

## Problem

One live domain failed on attempts2 versus required1. First Wafer first content
arrived12351ms into its request, inside14200ms precontent budget. Router deadline
expired with103chunks and1026JSON characters; second attempt escalated19994ms.

## Diagnosis

Exact unchanged live-support functions replay the recorded metadata and reject
it after one sample, as required. Runtime typed retry is intentional; the gate
requires first-attempt completion. Full first-attempt SSE/partial JSON is not
retained, so provider incomplete fields versus parser recovery defect or
postcontent scheduling remains unproven. Existing request dumps lack output.

## Solution

No fix proposed without original stream proof. Empty proposed.patch explicitly
records no justified candidate. Preserve original failure and all thresholds.
Owner may authorize later evidence collection; this worker made no live call.

## Human feedback

Parent required read-only source, no provider/model calls, no retry-until-green,
unchanged assertions/budgets, and first-bad-boundary proof before a candidate.

## Reusable lesson

Retain timed response bytes at a missed decision boundary before changing a parser or timing contract.
