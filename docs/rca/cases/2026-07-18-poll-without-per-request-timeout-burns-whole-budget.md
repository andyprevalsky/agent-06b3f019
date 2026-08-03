---
id: 2026-07-18-poll-without-per-request-timeout-burns-whole-budget
date: 2026-07-18
title: A poll loop with no per-request timeout let one stalled socket consume the entire 15s budget
surface: harness
component: semantic-gate
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: waitForTemporalWorkflow — polled GET /api/agents/:id every 50ms with no per-request AbortSignal, so one hung fetch never returned
symptoms:
  - "did not persist temporal_workflow_id within 15000ms; last=404"
  - Production Semantic Frontend Gate never green (0/60 runs)
  - agent_plan and agent_execute semantic paths fail 100%
tags:
  - semantic-tests
  - playwright
  - polling
  - fetch-timeout
  - ci-gate
sources:
  - PR #789
  - memory:project_semantic_gate_stale_backend_api_key
repro: the chat-lifecycle semantic spec run locally against prod (0 failures post-fix, 100% pre-fix)
status: fixed
---

## Problem

The Production Semantic Frontend Gate (`chat-lifecycle-ratchet.yml`) had never
been green — 0/60 runs since it was added on 2026-07-13. The `agent_plan` and
`agent_execute` paths failed 100% of the time with `Agent <id> did not persist
temporal_workflow_id within 15000ms; last=404`.

## Diagnosis

`waitForTemporalWorkflow` polled `GET /api/agents/:id` every 50ms with **no
per-request timeout**. The concurrent Playwright browser streams a live cloud
agent, saturating the shared origin and node event loop, so a single stalled
socket never resolved and consumed the entire 15s budget before the loop could
reach the healthy window. Prod logs proved the backend was fine: the agent exists
throughout, GETs return in 40–83ms, and `temporal_workflow_id` persists within
~2–8s. The apparent "15s is too short" symptom was really "one request was
allowed to be infinite" — an unbounded await inside a bounded budget, made worse
by a 50ms interval that added connection pressure to an already saturated origin.
Reproduced locally against prod before any fix was written.

## Solution

Give each poll its own `AbortSignal.timeout(2500ms)` and tolerate fetch errors and
transient 404s so the loop retries into the healthy 200 + `temporal_workflow_id`
window; poll interval relaxed 50ms→150ms to reduce connection pressure. The 15s
assertion is unchanged — no threshold or benchmark relaxation. Post-fix the full
lifecycle spec run locally against prod produced 0 `did not persist
temporal_workflow_id` failures. Remaining local latency-ratchet misses are
Mac→prod RTT artifacts (p50 ~2.9–3.0s vs ~1–2s in CI).

## Human feedback

The human asked for the "tank" ethos to be written into CLAUDE.md as rule 0a as
part of this work — own a prod gate end-to-end until it is genuinely green rather
than stopping at a plausible diagnosis. The fix was also deliberately constrained
to keep the assertion untouched instead of widening the 15s budget.

## Reusable lesson

Every request inside a bounded poll loop needs its own timeout — a "budget
exceeded" failure with a healthy server usually means one unbounded await ate the
whole budget, so bound the request instead of raising the budget.
