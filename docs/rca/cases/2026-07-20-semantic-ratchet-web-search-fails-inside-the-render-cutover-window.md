---
id: 2026-07-20-semantic-ratchet-web-search-fails-inside-the-render-cutover-window
date: 2026-07-20
title: The semantic chat-lifecycle ratchet fails web_search only inside the Render deploy-cutover window
surface: infra
component: semantic-gate
classification: third-party-failure
problem_class: timeout-too-aggressive
first_bad_boundary: chat-lifecycle ratchet web_search sample — 5s first-response budget measured while Render is still cutting over
symptoms:
  - "web_search first-response 6-12s against a 5s ratchet budget during deploy"
  - same sample passes at ~2s once prod settles
  - agent_plan / agent_execute paths pass throughout
tags:
  - semantic-gate
  - render
  - deploy
  - web-search
  - flake
sources:
  - memory:project_trace_manifest_at_creation_shipped
repro: none-recorded
status: mitigated
---

## Problem

Step 13b's prod semantic chat-lifecycle ratchet transiently fails on the
`web_search` sample: external search latency measures 6-12s against a 5s
first-response budget. The same sample passes at ~2s once prod settles, and the
agent paths (`agent_plan` / `agent_execute`) pass throughout.

## Diagnosis

The failure is confined to the **Render deploy-cutover window**. During cutover the
old and new instances overlap and prod is not yet steady-state, so the externally
bounded `web_search` path — the one sample whose latency is dominated by a
third-party search provider rather than by our own compute — exceeds its tight 5s
budget. Measuring a latency ratchet against an environment that is mid-deploy makes
the sample a measurement of the cutover, not of the build.

## Solution

Mitigation is procedural, not a budget change (raising the ratchet would be a gate
relaxation): re-run the ratchet after cutover settles rather than treating the
transient red as a regression. The distinguishing evidence is that only
`web_search` fails and that it passes at ~2s minutes later.

## Human feedback

None recorded.

## Reusable lesson

Do not evaluate a tight latency ratchet during a Render deploy cutover — re-run
after prod settles, and treat an externally-bounded sample failing alone as a
cutover artifact rather than a regression.
