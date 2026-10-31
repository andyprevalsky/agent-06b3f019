---
id: 2026-10-29-router-timely-first-content-missed-decision-deadline
date: 2026-10-29
title: Timely first content did not produce a router decision within the attempt deadline
surface: back-end
component: chat-router-live-failover
classification: unresolved
problem_class: other
first_bad_boundary: first router attempt reached 15000ms with 103 chunks and 1026 JSON chars but no actionable decision; retained output ends inside required goal string before mode arrives
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

One live domain failed on attempts 2 versus required 1. First Wafer first content
arrived 12351ms into its request, inside 14200ms precontent budget. Router deadline
expired with 103 chunks and 1026 JSON characters; second attempt escalated 19994ms.

## Diagnosis

Exact unchanged live-support functions replay the recorded metadata and reject
it after one sample, as required. Runtime typed retry is intentional; the gate
requires first-attempt completion. Existing dump extra.output retains the exact 1026-character first response,
truncated inside goal before mode. Unchanged production parser returns null for
that response and parses the second complete 1417-character output. Initial
top-level-only dump inspection was wrong and has been corrected. Why provider
required fields arrived too late remains unknown; per-chunk timing is absent.

## Solution

No fix is justified by this incomplete provider response. Exact retained output
proves the parser correctly lacked complete goal/mode; empty proposed.patch
records no candidate. Preserve original failure and all thresholds.
Owner may authorize later evidence collection; this worker made no live call.

## Human feedback

Parent required read-only source, no provider/model calls, no retry-until-green,
unchanged assertions/budgets, and first-bad-boundary proof before a candidate.

## Reusable lesson

Retain timed response bytes at a missed decision boundary before changing a parser or timing contract.
