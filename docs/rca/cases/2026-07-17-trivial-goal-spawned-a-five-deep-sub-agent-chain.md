---
id: 2026-07-17-trivial-goal-spawned-a-five-deep-sub-agent-chain
date: 2026-07-17
title: A "What is 2+2?" prod agent spawned a 5-deep sub-agent chain, blowing every semantic-gate timing window
surface: agents
component: spawn-agent
classification: our-bug
problem_class: model-intelligence-limitation
first_bad_boundary: spawn_agent — no recursion guard for a trivial goal, so each level re-delegated "Compute 2+2"
symptoms:
  - "Agent never produced ≥2 realtime message bubbles, Received: 0"
  - "chat-lifecycle-latency first-response Timeout 15000ms exceeded on all 5 samples"
  - "Agent did not persist temporal_workflow_id within 15000ms; last=404 {temporal_workflow_id:null}"
  - one-word tasks take minutes to complete in prod
tags:
  - spawn-agent
  - recursion
  - prod
  - semantic-gate
  - latency
sources:
  - memory:project_prod_agent_runaway_spawn_completion_summary
  - agent 39cd4564
repro: none-recorded
status: open
---

## Problem

The prod `chat-lifecycle-ratchet.yml` semantic gate (Step 13b of `/deploy`) was
persistently RED with two signatures: `agent-realtime.spec.ts:28` and
`mobile-layout.spec.ts:104` reporting "Agent never produced ≥2 realtime message
bubbles, Received: 0" (180s/120s timeouts), and `chat-lifecycle-latency.spec.ts`
exceeding its 15000ms first-response budget on all 5 samples for every mode. A
manual prod probe with goal "What is 2+2?" (`start_phase: execute`, agent
`39cd4564`) eventually COMPLETED with "four" — after minutes.

## Diagnosis

`agent_logs.py <id> --tree --diagnostics --prod` on that probe showed the trivial
task spawning a **5-deep sub-agent chain**
(39cd4564 → 8441fa24 → c51e6935 → 4bfa420a → da0aae25 …), each level re-asking
"Compute 2+2". Nothing bounded delegation depth for a goal that needed none, so
one-word tasks took minutes, every semantic timing window expired, and zero
bubbles rendered.

The backend itself was healthy throughout (`POST /api/agents` 201 with a
`temporal_workflow_id`, list GET 200, compute-token heartbeat 200; later runs
showed 13/13 prod endpoint smoke and 0 error log lines), and recent prod agents
were completing — so this was agent-runtime degradation, not an outage. By
2026-07-18 the signature had shifted to "did not persist temporal_workflow_id
within 15000ms", consistent with prod Fly worker saturation caused by this same
runaway-spawn class rather than by completion latency alone.

## Solution

Not fixed in the recorded sessions. The identified candidate fixes are agents-side:
a `spawn_agent` recursion guard for trivial goals, plus the `attempt_completion`
stuck-verifier and the `completion_summary` request failure tracked separately. The
gate was repeatedly confirmed pre-existing (identical failures on main before the
#777, #784 and #788 merges) and escalated rather than worked around.

## Human feedback

The user's standing rule against blocking or hacking an unrelated PR on a
pre-existing prod failure was applied: the gate was escalated to the user with
proof of pre-existence (identical failures on main at 05:12Z 2026-07-14, 01:13Z and
05:06Z 2026-07-18) instead of relaxing the ratchet or altering FE code to make it
pass.

## Reusable lesson

When semantic timing gates go red with zero rendered bubbles, check the agent tree
depth for a trivial goal before touching timeouts — unbounded self-delegation turns
a one-word task into minutes and saturates the worker fleet.
