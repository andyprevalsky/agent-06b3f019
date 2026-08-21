---
id: 2026-07-25-bench-agent-links-pointed-at-the-ephemeral-hub
date: 2026-07-25
title: Benchmark/descend agent links pointed at the ephemeral hub instead of the durable archive-backed prod viewer, so they rotted when the stack died
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: "descend/run-bench link emission — surfaced localhost:60784/open-agent (ephemeral hub) rather than the always-on backend's archive-fallback route"
symptoms:
  - verified FE link for a benchmark agent 404s or refuses connection after the run
  - "*.trycloudflare.com tunnel and localhost:60784 hub are gone once the stack tears down"
  - browser recording in a rehydrated bench agent points at a dead ephemeral Supabase
tags:
  - benchmarks
  - trace-archive
  - open-agent
  - r2
  - link-rot
sources:
  - memory:project_bench_agent_rehydration_idea
  - plan:docs/plans/active/bench-agent-rehydration.md
repro: none-recorded
status: mitigated
---

## Problem

Benchmark and descend deliverables include a "verified FE link" to the agent
run, but those links died as soon as the ephemeral stack that produced them
tore down: the hub (`localhost:60784`) and its `*.trycloudflare.com` tunnel are
gone, and cloud-fleet bench agents are never written to the prod DB (only the
one production task agent on roselabs.ai is).

## Diagnosis

A direct code read on 2026-07-25 showed the durable viewer already existed and
the links were simply pointed at the wrong host. `GET /api/agents/:id` and
`/tree` fall back to `findAgentAcrossRuns`/`findTreeAcrossRuns`
(`back-end/src/domains/agents/agentQueryService.ts:48,118,128` →
`back-end/src/providers/benchmarkHubStore.ts:547,581`) when the agent is absent
from the live DB, and `getRunAgent` (benchmarkHubStore.ts:442) rebuilds
`{agent, messages, tree}` from R2 trace-archive bundles preserving message
metadata (line 381), shaped exactly like the normal API so the main FE panel
renders it unchanged (gated by `canReadBenchmarkArchive`). So
`roselabs.ai/open-agent?agent-id=X` already rehydrates a dead-stack bench agent
from R2. The defect was the emitted URL, not the persistence layer. Two related
gaps remain: the archive fallback serves the original
`recording_file_pointer` (possibly-dead ephemeral Supabase) instead of the
durable R2 copy that `agents/domains/spawn_browser_agent_v3/recording.py:500`
already writes to `media/browser/{task_id}/...`, and cloud/fleet runs must
finalize + index their bundle for `findAgentAcrossRuns` to resolve it on prod.

## Solution

Landed in stages:

1. **Emit durable FE links / dual-write Hub bundles** (2026-08-21): local
   `run-bench` stacks still fail-closed-register against the ephemeral Hub, but
   terminal bundles are mirrored to the always-on production Hub
   (`agents/benchmarks/hub_upload.py::mirror_run_bundle_to_durable_hub`) and
   runs print `https://www.roselabs.ai/open-agent?agent-id=…`. Cloud Agents
   (`CURSOR_AGENT`) fail closed if the durable mirror fails. RCA/approval
   Evidence must use that durable URL via
   `scripts/publish_evidence_links.py`, not localhost/ngrok.
2. **Still open:** rewrite archived `recording_file_pointer` to durable R2
   media, and guarantee cloud/fleet runs finalize media into the indexed
   bundle. Plan remnants may still live under `docs/plans/`.

## Human feedback

The human re-scoped this from "nice to have" to a follow-up he greenlit
explicitly: dead-stack bench agents must be viewable later "like a db snapshot
or archive", in the "exact same FE, all features incl. browser recordings" —
not a reduced or bespoke viewer. On 2026-08-21 he further required FE links
and LLM dumps to remain reachable for multiple days for current and future
agents (Cursor artifacts + durable open-agent).

## Reusable lesson

When a run artifact must outlive the stack that produced it, publish links
against the always-on service that can rehydrate from the archive — never
against the ephemeral hub or tunnel that created the run.
