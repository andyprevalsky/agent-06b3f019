---
id: 2026-11-11-semantic-bubble-prerequisite-waited-for-agent-completion
date: 2026-11-11
title: Realtime/mobile semantic specs counted only top-level bubbles, so they waited for the agent to finish instead of for realtime rows
surface: front-end
component: semantic-e2e-specs
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/agent-realtime.spec.ts and mobile-layout.spec.ts — the ≥2 `[data-message-id]` poll counted top-level rows while TrajectoryWorkGroup folds every live assistant/tool row into a collapsed header with no data-message-id
symptoms:
  - Agent never produced ≥2 realtime message bubbles
  - Agent never produced ≥2 realtime message bubbles on mobile
  - Waiting for Collatz Python
  - Tool interrupted by deployment
tags:
  - playwright
  - semantic-gate
  - trajectory-work-group
  - codex
  - flaky-latency
sources:
  - PR #1919
  - commit c421fdb118f7b2fe3510527dbb884bfe68837c3d
  - agent be45d30f-8ca8-4d91-be59-33280e444c01
  - agent 6c636eb6-336f-434e-9958-63debb538183
repro: front-end/tests-e2e/agent-realtime.spec.ts and front-end/tests-e2e/mobile-layout.spec.ts (agent-active case) on a stack started with ROSE_CODE_AGENT_PROVIDER=codex
status: fixed
---

## Problem

In the deploy semantic-stack gate (GH runs 42942329913 on c421fdb1 and 42926707466 on base 1f1e176a) both live specs failed both attempts on two
sources with `Agent never produced ≥2 realtime message bubbles`, `Expected: >= 2,
Received: 1`; the realtime spec then hit its 180 s test timeout. The CI page
snapshot showed the user goal plus one collapsed work-group header ("Waiting for
Collatz Python", later "Tool interrupted by deployment 3m 04s"). Later sources
passed in 65–79 s, so the failure was intermittent.

## Diagnosis

A local probe on main (`ad74b9db5`) sampled the DOM every 3 s. For 79 s the page
held exactly one `[data-message-id]` (the user goal) while 37 realtime messages
arrived. Every assistant/tool row was folded into a single running
`TrajectoryWorkGroup`, whose header carries no `data-message-id`. The count reached
2 only when the agent's final user-facing answer landed (`isUserFacingWorkBoundary`).
The prerequisite therefore measured "the agent finished", not "realtime rows
rendered", contrary to the spec's stated intent.

How long the agent took depended on which code CLI ran.
`_select_code_provider` (agents/domains/spawn_claude_code_agent/handler.py)
chooses Codex when the workflow holds a GPT compute lease. In CI the lease was
healthy, and all four test agents created `Codex Code session`s. Worker-0 events
for the Codex child show sparse `agent_message`s 50–75 s apart and no command
execution for 2.5 minutes. Locally the user GPT lease was `Marked compute token
rate-limited`, which left `compute_token_provider=None`; Claude Code then finished
in about 50 s. The "Tool interrupted by deployment" row was written at 02:01:05,
which was test timeout plus `deleteAgent` cleanup. It was a consequence of the
failure, not its cause.

Repro: on the same local stack started with the supported override
`ROSE_CODE_AGENT_PROVIDER=codex`, the unchanged specs failed with the exact CI
errors (realtime: `Received: 1` after 3.1 m; mobile: `Received: 1` after 2.2 m).
Six concurrent default-provider runs had all passed, because Claude Code was used.

## Solution

`countMessageRowsWithWorkExpanded` (front-end/tests-e2e/helpers.ts) opens every
collapsed trajectory work group before counting `[data-message-id]`. The live rows
then render through the normal history path. Both prerequisite polls use it.
Assertions, thresholds, timeouts and the dedup, non-user-content and 390 px
overflow checks are unchanged, and they now also cover the in-flight streaming rows.
On the same Codex stack, the fixed specs passed in 14–16 s (realtime) and 6–8 s
(mobile agent-active), five consecutive times each. Production code is unchanged,
so there is no 10k-agent impact.

## Human feedback

The assignment required preserving test intent, assertions, timeouts and
dedup/layout checks, reproducing before changing anything, and never waiving
or re-delegating these tests.

## Reusable lesson

When a live UI spec waits for N top-level `[data-message-id]` bubbles, open the
collapsed trajectory work groups first, or it is really waiting for the agent to
finish.
