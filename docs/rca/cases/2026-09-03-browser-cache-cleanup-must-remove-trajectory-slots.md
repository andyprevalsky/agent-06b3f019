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
  - Visible spawn_agent complete cards claimed nested research was skipped
tags:
  - fast-cache
  - saved-trajectory
  - browser-agent
  - cache-replay
  - oai-demo
  - nested-agent
sources:
  - agent 149f16bd-58e1-471e-90b3-d3e9a0cefd8f
  - fleet run a19002d6-005e-47c3-abc8-23aa969f28f9
  - agent 838b95d7-8a6c-424f-8473-b002dc782aa9
  - fleet run 3f4eaee8-6da5-4189-b2d2-ad1e14b76f12
  - agent 5f8eb7f8-881d-4531-a94a-9b65dd42120b
  - fleet run b8398b56-fb95-42a3-af90-aa6aa6be21c7
  - agent 732a714e-4d91-42c0-954b-8973533f35bb
  - agent 131eac5e-4501-4b6c-9d62-97c955997d4c
  - fleet run 4a3f33b5-7e16-406f-a4fc-90de361e4428
  - agent 30e3ac36-d72e-48c1-8242-fbbb4c244daa
  - fleet run 062084fe-9d2a-4576-9caf-7f145084ec52
  - agent 2e15fec3-fe6e-449f-838c-a0a00cfec081
  - fleet run 5df83f8e-3705-4b9a-b746-1884026759a9
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

On 2026-09-05, the human additionally required the mass-agent benchmark to show
no synthetic `spawn_agent complete` cards saying that research or code work was
skipped and required that behavior to be enforced by the benchmark's declared
validation criteria.

## 2026-09-05 recurrence: nested-agent replay slots

A run that passed the older benchmark contract still exposed six first-level
creator cards with the exact text `Research already gathered; skipping nested
spawn so the main sub-agent handles it.` and the title `spawn_agent complete`.
The runtime guard prevented a cached nested spawn from multiplying the fan-out,
but presented the guard as successful work. The benchmark had no criterion for
that visible defect.

A bounded scan of all 50 known creator-child namespaces found 1,153 runtime
rows with nested general-purpose calls across seven namespaces. The maintenance
job archived those exact rows in place under `oai_demo_backup`; a second scan
found zero browser or nested-agent calls in those runtime namespaces. The
recognizer covers unified general-purpose, for-each, and code types plus their
legacy tool names, so the code-agent variant fails closed even though this
fixture contained no current code-agent row.

The exact current task was then tested with one archived child namespace
temporarily and reversibly restored. With task definition SHA-256
`7ea233a2830a858874356cfa29b65e33225cd747c2ad4ef4d0a97dc431c232ae`, the
following command failed on fleet run
`062084fe-9d2a-4576-9caf-7f145084ec52` (agent
`30e3ac36-d72e-48c1-8242-fbbb4c244daa`) at
`t6-no-synthetic-agent-skips` with the original visible skip text. Reapplying
the maintenance job archived the restored namespace's 221 then-current rows;
the immediate dry-run audit found zero remaining disallowed rows.

```bash
set -a; source back-end/.env; set +a
export FAST_MODE_CACHE_DATABASE_URL="$DATABASE_URL"
scripts/run-bench --local test-mass-agent-run-0
```

The identical task definition and benchmark command then passed on fleet run
`5df83f8e-3705-4b9a-b746-1884026759a9` (agent
`2e15fec3-fe6e-449f-838c-a0a00cfec081`) with 51 agents, 264 messages, 100%
Fast Mode cache hits, zero agent cost, and every declared evaluator satisfied.
The durable viewer was verified at
`https://www.roselabs.ai/?agent-id=2e15fec3-fe6e-449f-838c-a0a00cfec081`.

At 10k-agent scale, the maintenance path remains a one-time scan of 50 explicit
goal hashes followed by one transactional bulk update. Runtime validation scans
only the already-collected raw trees for its single benchmark run. The root
namespace is intentionally outside the cull because it owns the legitimate
first-level fan-out to 50 creator children; the declared evaluator fails closed
if any root or child source renders a nested GP, for-each, or code replay as a
synthetic success card.

## Reusable lesson

When removing a tool action from a recorded trajectory, archive its entire
replay slot; never mutate that slot into replacement work, an empty response,
or a synthetic success card.
