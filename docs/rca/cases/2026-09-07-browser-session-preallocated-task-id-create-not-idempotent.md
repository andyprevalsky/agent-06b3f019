---
id: 2026-09-07-browser-session-preallocated-task-id-create-not-idempotent
date: 2026-09-07
title: Preallocated BrowserSession.id create was not idempotent, so retries hit Unique constraint on (id)
surface: cross
component: browser-session-persist
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/sessionPersist.ts — BrowserSession.create with preallocated taskId lacked create-or-reclaim
symptoms:
  - "Unique constraint failed on the fields: (`id`)"
  - "Browser session init failed after 5 transient-proxy retries"
  - "Invalid `prisma.browserSession.create()` invocation"
  - "Browser automation failed"
  - "Failed during: initialization"
tags:
  - browser-session
  - idempotency
  - temporal-retry
  - kernel
  - steel
  - unique-constraint
  - transient-init
sources:
  - agent 43b3a83b-646e-4656-a785-55c5f1a62041
  - commit 9cbd50a5f
repro: back-end/src/tests/unit/browser-session-persist.test.ts + agents init_browser_session_unique_constraint_not_transient
status: fixed
---

## Problem

Prod agent `43b3a83b-646e-4656-a785-55c5f1a62041` (Madrid apt search) spawned
multiple browser agents; every spawn failed at initialization with:

`Browser session init failed after 5 transient-proxy retries:
{"error":"Invalid prisma.browserSession.create() invocation: Unique constraint
failed on the fields: (`id`)"}`.

Seven distinct `tool_call_id` / stable `task_id` pairs each burned the full
transient-proxy retry budget on the same unique-constraint error.

## Diagnosis

Critical path: `spawn_browser_agent` → `init_browser_session` →
`POST /api/browser-session/init` → provider `create` →
`prisma.browserSession.create({ id: taskId })`.

Commit `9cbd50a5f` (2026-09-06) preallocates a stable browser ownership id
(`uuid5(agent_id, tool_call_id)`) and writes it as `BrowserSession.id` so
cancellation retains task-scoped terminal events. Create remained non-idempotent.

On Temporal activity retry, or on a transient-init retry after a prior create
left the row (close marks CLOSED/ERROR and does not delete), the second create
with the same `task_id` raises P2002. The backend returns HTTP 500. The agent
classifier treats all 5xx as transient (over-broad relative of case
`2026-07-20-transient-proxy-init-failure-classified-fatal`), so the same doomed
create is retried five times and surfaced as a "transient-proxy" failure.

Deepest owned cause: a Temporal/retry side-effect (DB insert keyed by a stable
id) was not idempotent — CLAUDE rule 20 / activity at-least-once.

## Solution

1. `persistBrowserSessionRow` — create-or-reclaim for preallocated task ids
   (id-scoped P2002, CAS `updateMany` on `id` + previous `sessionId`, release
   superseded/orphaned remotes). Wired into Kernel, Steel, and local creates.
2. Defense in depth: unique-constraint / P2002 init bodies are never classified
   transient, even on HTTP 5xx.
3. Cemented by unit + browser-session blackbox (CLOSED and ACTIVE reclaim) and
   agent blackbox `init_browser_session_unique_constraint_not_transient`.

At 10k agents: per-task reclaim is O(1) keyed by task id; no shared fan-in.
Sibling prevented: any future stable-id create under Temporal/transient retry.

## Human feedback

None recorded.

## Reusable lesson

When a stable id is used as a DB primary key across Temporal or transient
retries, persist must create-or-reclaim — never plain create — and do not
classify unique-constraint 5xx as transient proxy failures.
