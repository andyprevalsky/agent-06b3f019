---
id: 2026-11-04-code-agent-sandbox-time-unbilled-on-pause-and-cancel
date: 2026-11-04
title: Code-agent sandbox time was unbilled on idle pause, usage limit and user cancel, and priced at a fixed 2-vCPU rate
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py spawn_claude_code_activity returned usage_items [] (or none) on the paused, usage_limit and cancelled ends, and build_usage_items priced E2B time with the fixed E2B_COST_CENTS_PER_SECOND
symptoms:
  - "usage_items": [] on a paused code agent result
  - multi-day code agent cost far below its E2B sandbox time
  - 8-vCPU code sandbox billed at the 2-vCPU rate
  - Mac (target local) code agent billed for an E2B sandbox
tags:
  - claude-code
  - codex
  - cost-accounting
  - e2b
  - multi-day
sources:
  - commit 28a7bfc99
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_claude_code_every_end_of_a_run_reports_sandbox_usage_by_size; ::test_cc_execute_tool_cancelled_run_tracks_its_sandbox_usage
status: fixed
---

## Problem

A multi-day run normally goes idle pause -> respawn, but the idle-pause and
usage-limit results returned `usage_items: []`, the cancel result returned
none, and the handler's cancel branch returned before its usage block. Most
E2B seconds were never recorded in the cost ledger. The E2B rate was a fixed
2-vCPU price even for resized 8-vCPU sandboxes, and a run on the user's Mac
was billed as an E2B sandbox.

Local repro (ActivityEnvironment, fake clock, idle-paused loop):
pre-fix `an idle-paused run must bill its sandbox time: []`; handler cancel
pre-fix: no `data.usage` on the paused row. Post-fix: idle pause, user cancel
and usage limit bill sandbox seconds; an 8-vCPU sandbox costs exactly 4x a
2-vCPU one per second; the handler forwards cancel usage to `_track_usage`.

## Diagnosis

Usage was built only on the completed path (`build_usage_items` after the
verifier); every other end returned a literal empty list. The rate constant
predates sandbox sizes (C16), and `code_agent_meta` (target, sandbox_size) was
never passed to the pricing function.

## Solution

`build_usage_items` takes `code_agent_meta`: E2B time = seconds x
`E2B_COST_CENTS_PER_VCPU_SECOND` (0.0014c) x vCPUs (default 2), nothing for
`target == "local"`. `_sandbox_usage_items` reports sandbox time on the
paused, usage-limit and cancelled ends; the handler forwards cancel usage via
`_workflow_tool_usage`. Billing starts at the session's `started_at`, which a
reattached attempt inherits, so drained/retried attempts are billed once.

Open: price-limit enforcement while a run is attached (agent-behaviour
semantics) is not built; a resized run is priced at its final size for the
whole run; the final failed-error path still reports no usage (it raises).

10k agents: pure computation on existing result dicts; no new calls.

## Human feedback

None recorded.

## Reusable lesson

Every way a metered resource's run can end must report its usage, priced by
the resource's actual size; an empty usage list on a non-success path is a
silent unbilled leak.
