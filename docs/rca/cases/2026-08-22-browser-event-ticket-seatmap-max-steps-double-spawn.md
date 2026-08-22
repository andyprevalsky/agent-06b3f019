---
id: 2026-08-22-browser-event-ticket-seatmap-max-steps-double-spawn
date: 2026-08-22
title: Browser hit max steps on AMC seat map; root respawned browser and exact count failed
surface: agents
component: spawn_browser_agent_v3 seat interaction + expected_tool_counts
classification: our-bug
problem_class: other
first_bad_boundary: AMC seat-map interaction in spawn_browser_agent_v3 — clicks leave Next disabled / coordinate misses until Max Steps; root then issues a second spawn_browser_agent against expected_tool_counts=1
symptoms:
  - "spawn_browser_agent exceeded its exact root call limit during execution: expected 1, got 2"
  - "Task Incomplete - Max Steps Reached"
  - "Cannot humanize click for element index"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "recorded 0 trajectory step(s); expected at least 5"
tags:
  - browser-event-ticket
  - seat-map
  - max-steps
  - expected-tool-counts
sources:
  - agent 5e84be3b-b9ea-4dda-94d7-40eea5cfea98
  - commit c7bcf0c7f120ef38550767b6454c8529e7669eea
repro: pending — needs owning-boundary seat-click repro; do not raise expected_tool_counts
status: open
---

# RCA: seat-map stall → max steps → double spawn_browser_agent

## Problem

Sequential k=5 attempt `5e84be3b-…` used correct Friday Aug 28 goal, reached
AMC seats/tickets URLs, then ended `Max iterations (60) reached` without
payment. Root called `spawn_browser_agent` a second time. Static checks failed:
`expected 1, got 2`, no `payment_approval`, second call `0 trajectory steps`.

## Diagnosis

Path: seats page → click seat / Next stays `disabled: True` → coordinate miss
`Cannot humanize click for element index … no coordinates` → loops evaluate/
navigate → max steps ERROR → root retries spawn → exact count fail.

The count check is **correct** (do not raise to 2 — process-feedback rule 7).
Upstream failure is seat selection not advancing checkout.

Relative: `2026-08-21-imax-no-tool-failures-recoverable-element-index-miss`
(DOM index miss); `2026-08-03-hidden-checkable-control-discarded-associated-label-coordinates`.

Owning-boundary local repro for the seat/Next-disabled loop is **not yet
closed** (needs recorded AMC seat DOM or deterministic fixture). Outcome
symptom is reproduced in the run artifact above.

## Solution

Proposed direction (not implemented): fix seat-map click path so selecting an
available recliner enables Next / proceeds to payment in one browser session.
Do **not** relax `expected_tool_counts.spawn_browser_agent: 1`.

## Human feedback

None recorded. Standing rule: never relax exact tool-count contracts to hide
retries.

## Reusable lesson

When `expected_tool_counts` fails on a second `spawn_browser_agent`, diagnose
why the first browser session never reached payment — do not raise the count.
