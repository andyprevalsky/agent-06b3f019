---
id: 2026-07-25-bench-agent-links-pointed-at-the-ephemeral-hub
date: 2026-07-25
title: Benchmark/descend agent links pointed at the ephemeral hub instead of the durable archive-backed prod viewer, so they rotted when the stack died
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: "report/RCA evidence emission — BENCHMARK_REPORT_FRONTEND_URL + render_llm_dump file:// recordings"
symptoms:
  - verified FE link for a benchmark agent 404s or refuses connection after the run
  - FE link expired/unreachable
  - rendered LLM dump HTML embeds file:// recording frames that break for remote reviewers
  - invalid browser recordings attached in approval LLM dumps
  - BENCHMARK_REPORT_FRONTEND_URL pointed at localhost dashboard mirror
tags:
  - benchmarks
  - link-persistence
  - open-agent
  - r2
  - link-rot
  - render-llm-dump
sources:
  - memory:project_bench_agent_rehydration_idea
  - plan:docs/plans/active/bench-agent-rehydration.md
  - agent bc-3bfd5c49-bed2-4b68-bfc5-9fa9b1934d70
repro: agents/tests/blackbox/render_llm_dump.blackbox.py::test_published_dump_never_embeds_file_uri_recordings + agents/benchmarks/report_card_test.py::test_report_frontend_url_defaults_to_durable_prod
status: mitigated
---

## Problem

Benchmark and descend deliverables include a "verified FE link" to the agent
run, but those links died as soon as the ephemeral stack that produced them
tore down: the hub (`localhost:60784`) and its `*.trycloudflare.com` tunnel are
gone, and cloud-fleet bench agents are never written to the prod DB (only the
one production task agent on roselabs.ai is).

Recurrence 2026-08-21: `/rca` and `/descend` approval packs demand an FE link
and a rendered LLM dump link; both routinely went dead. Published dumps also
attached invalid browser recordings because frame `src` values were absolute
`file://` URIs that only resolved on the render machine.

## Diagnosis

A direct code read on 2026-07-25 showed the durable viewer already existed and
the links were simply pointed at the wrong host. `GET /api/agents/:id` and
`/tree` fall back to `findAgentAcrossRuns`/`findTreeAcrossRuns`
(`back-end/src/domains/agents/agentQueryService.ts` →
`back-end/src/providers/benchmarkHubStore.ts`) when the agent is absent
from the live DB, and `getRunAgent` rebuilds `{agent, messages, tree}` from R2
bundles preserving message metadata, shaped exactly like the normal API so the
main FE panel renders it unchanged (gated by `canReadBenchmarkArchive`). So
`https://roselabs.ai/?agent-id=X` already rehydrates a dead-stack bench agent
from R2 for admin readers. The defect was the emitted URL, not the persistence
layer.

Local repro (2026-08-21):

1. `_report_frontend_url_for_benchmark("http://127.0.0.1:3099")` with
   `CONDUCTOR_PORT=3001` returned `http://127.0.0.1:3100` (ephemeral). Cloud
   dashboard mode forced
   `BENCHMARK_REPORT_FRONTEND_URL=http://localhost:$LOCAL_DASH_PORT`.
2. `scripts/render_llm_dump.py` published HTML whose recording player embedded
   `file:///.../frames/frame_*.jpg`. After wiping the source recording dir, all
   `file://` URIs were broken (3/3). Missing frames still emitted a
   "Browser Recording" error section.

Related remaining gap: the archive fallback can still surface original
`recording_view_url` / `recording_file_pointer` values that point at Kernel or
ephemeral storage instead of the durable R2 `media/browser/...` copy.

## Solution

Landed 2026-08-21:

1. `_report_frontend_url_for_benchmark` / `durable_agent_frontend_url` default to
   `https://roselabs.ai` and reject ephemeral hosts unless
   `BENCHMARK_REPORT_ALLOW_EPHEMERAL=1`. Report-card agent URLs use the durable
   helper. `scripts/run-bench-cloud` exports
   `BENCHMARK_REPORT_FRONTEND_URL=https://roselabs.ai` (not the localhost dash).
2. `scripts/render_llm_dump.py` materializes recording frames into the HTML
   `_assets` sidecar with relative URLs (or data URIs for in-memory renders).
   Never emits `file://`. Missing/empty frames omit the player entirely.
3. Approval-format contract now requires durable FE links and forbids attaching
   invalid recordings.

Still open: backend route to serve archived `media/browser/...` and rewrite
recording pointers in `getRunAgent` so the FE chip itself never iframes a dead
Kernel/Supabase URL after rehydration.

## Human feedback

The human re-scoped this from "nice to have" to a follow-up he greenlit
explicitly: dead-stack bench agents must be viewable later "like a db snapshot
or archive", in the "exact same FE, all features incl. browser recordings" —
not a reduced or bespoke viewer.

2026-08-21: "That should NEVER happen, they should be persistant AND we should
never get invalid browser recordings attached."

## Reusable lesson

When a run artifact must outlive the stack that produced it, publish links
against the always-on service that can rehydrate from the archive — never
against the ephemeral hub or tunnel that created the run — and never embed
machine-local `file://` media in reviewer-facing HTML.
