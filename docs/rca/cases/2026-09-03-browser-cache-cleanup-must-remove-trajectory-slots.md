---
id: 2026-09-03-browser-cache-cleanup-must-remove-trajectory-slots
date: 2026-09-03
title: Browser cleanup retained invalid runtime replay slots
surface: back-end
component: fast-cache-maintenance
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/clean-oai-demo-browser-cache.ts buildArchivePatches
symptoms:
  - Declared evaluator t5-zero-live-spend failed
  - No JSON content received in response (chunks=3, model=fast-cache)
  - cost_cents is 16
  - cache_creation_input_tokens is 163201
tags:
  - fast-cache
  - saved-trajectory
  - browser-agent
  - cache-replay
  - oai-demo
sources:
  - agent 149f16bd-58e1-471e-90b3-d3e9a0cefd8f
  - fleet run a19002d6-005e-47c3-abc8-23aa969f28f9
  - agent 838b95d7-8a6c-424f-8473-b002dc782aa9
  - fleet run 3f4eaee8-6da5-4189-b2d2-ad1e14b76f12
  - agent 5f8eb7f8-881d-4531-a94a-9b65dd42120b
  - fleet run b8398b56-fb95-42a3-af90-aa6aa6be21c7
repro: back-end/src/tests/blackbox/fast-cache.blackbox.ts
status: fixed
---

## Problem

The saved OAI mass-agent demo contained 438 browser calls in six creator
trajectories. The first cleanup attempt converted those calls into explore
calls while retaining their runtime cache slots. Exact benchmark run
`a19002d6-005e-47c3-abc8-23aa969f28f9` then failed
`t5-zero-live-spend`: the replacement work missed the saved trajectory and
produced 16 cents of spend, 163201 cache-creation input tokens, and 6381 live
output tokens.

Deleting browser tool calls only from each cached value did not repair the
trajectory. The next exact attempt returned `No JSON content received in
response (chunks=3, model=fast-cache)` for five creator children because the
same cache keys now replayed structurally empty model turns.

## Diagnosis

The cache entry is a stateful replay slot, not an independent blob. Its tool
call determines the tool result and context expected by later positional cache
entries. At the first bad boundary, the initial
`clean-oai-demo-browser-cache.ts` implementation changed a browser-bearing
value but kept its original runtime key. Converting the call scheduled new
uncached work; removing the call left an empty turn at the same position. In
both cases the fixture no longer matched the runtime trajectory contract.

The deepest owned cause was treating action removal as value sanitization.
Because saved tool calls and subsequent cache positions form one trajectory,
the owning replay slot itself must become unavailable when its action is
removed. The pre-fix blackbox failed until the cleanup contract exposed
`deleteEntry: true`; the final cache audit found zero browser-bearing runtime
rows, and exact run `b8398b56-fb95-42a3-af90-aa6aa6be21c7` completed 50 of 50
children at zero spend and zero cache writes.

## Solution

`oaiDemoCacheCleaner.ts` now recognizes both `spawn_browser_agent` and
`spawn_agent` with `type=browser`, removes them from preview values without
adding executable work, and marks the whole entry for deletion from replay.
`clean-oai-demo-browser-cache.ts` implements that contract reversibly: it
restores originals from prior cleanup backups, then archives each complete row
in place under a non-runtime key and `oai_demo_backup` kind. No cache row or
provider-accounting payload is copied, and stripping the archive prefix can
restore the original key.

The benchmark now forbids `spawn_browser_agent` and statically requires three
HTML reports plus two CSV reports. The owning unit and fast-cache blackbox
prevent both sibling regressions: replacing removed browser work with another
tool and retaining an empty runtime slot. At 10k-agent scale, maintenance is
bounded to the six explicit goal hashes, scans each targeted cache row once,
and performs one bulk in-place update; normal agent trajectories are untouched.

## Human feedback

The human required browser uses to be removed from the saved trajectory, with
the result presented as the cleanest, crispest possible demo and judged by the
IDEA validation criteria. They also required the final files to use the newly
supported formats that maximize human readability.

## Reusable lesson

When removing a tool action from a recorded trajectory, archive its entire
replay slot; never mutate that slot into replacement work or an empty response.
