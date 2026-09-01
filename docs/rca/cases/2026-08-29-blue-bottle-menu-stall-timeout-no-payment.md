---
id: 2026-08-29-blue-bottle-menu-stall-timeout-no-payment
date: 2026-08-29
title: Blue Bottle browser burned the full 1200s inside menu add-to-cart / evaluate loops without reaching payment_approval
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: other
first_bad_boundary: spawn_browser_agent_activity_v3 menu interaction loop — add-to-cart / evaluate / wait cycle until harness dynamic cap 1200s with approvals_triggered=0
symptoms:
  - Timeout after 1200s (dynamic cap=1200s)
  - Expected payment_approval attention request (to ignore) but none was triggered
  - Clicked <button "Add item to cart">
  - Troubleshooting click function
  - spawn_browser_agent_activity_v3 1202.3s
tags:
  - blue-bottle
  - timeout
  - browser-agent
  - payment-approval
  - menu-stall
sources:
  - fleet run 670cb9b0-5781-4c46-a4e8-9b93c3910842
  - agent 0516148f-c93d-4e66-a9ba-0002080d7a97
  - PR #1069
repro: pending — live outcome on unchanged scripts/run-bench --local; no fast owning-boundary yet
status: open
---

## Problem

Post kill-switch k=5 trial `0516148f` hit `Timeout after 1200s` with
`approvals_triggered=0`. Latency profile: `spawn_browser_agent_activity_v3` 1202.3s
(2.2× historical tool_dispatch p95). Last actions were Specialty Beverages → Add item to
cart → screenshot → evaluate/wait while troubleshooting clicks. `auth_source=none`.

## Diagnosis

Archive searches: `browser timeout no payment_approval`, `evaluate timeout`. Relatives:
`2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery`,
`2026-08-22-evaluate-cdp-await-unbounded-burns-task-budget` — similar budget burn, different
proven first-bad (CDP freeze). This trial’s last titles are ordinary menu clicks/evaluate,
not a classified CDP stall. **Relative class** (budget burned before payment), novel
instance on Blue Bottle guest path.

Do not bump `timeout_seconds` (process-feedback / rule 25).

Hard gate: outcome reproduced; causal CDP-vs-model boundary not isolated → **open**.

## Solution

**Proposed:** Diagnose with verbose `agent_latency.py` + browser recording frames whether
clicks no-op (DOM/overlay) or CDP stall; fix the stall class if evidenced; otherwise treat
as trajectory variance and fold into guest/store-selection reliability work. Never raise
the 1200s cap to manufacture a pass.

## Human feedback

User asked for `/rca` of failing k=5 runs; prior Blue Bottle work forbids timeout relaxation.

## Reusable lesson

A 1200s Blue Bottle timeout with zero payment_approval is a progress failure inside the
browser loop — profile the last actions before touching the task timeout.
