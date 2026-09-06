---
id: 2026-09-05-generic-schema-cache-title-overwrote-agent-name
date: 2026-09-05
title: Generic schema-cache title overwrote the agent name
surface: agents
component: fast-cache-schema-replay
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py set_response_schema_activity fast-cache hit
symptoms:
  - Fast Mode renamed the root task to Task Output
  - agent.title was Task Output
tags:
  - fast-cache
  - response-schema
  - generated-title
  - cache-replay
sources:
  - agent 81667fce-9a5a-4e7c-b05c-2c5d6736d6ad
  - agent 2e15fec3-fe6e-449f-838c-a0a00cfec081
  - fleet run 5df83f8e-3705-4b9a-b746-1884026759a9
repro: agents/tests/blackbox/llm.blackbox.py
status: fixed
---

## Problem

Fast Mode replayed the historic placeholder `Task Output` as the generated
title for the root mass-agent task. Runtime inspection of agent
`81667fce-9a5a-4e7c-b05c-2c5d6736d6ad` showed that the response schema itself
was populated, but the owning `agent.title` field had been persisted with the
generic value. The benchmark originally had no declared criterion for task
identity, so generic naming could survive an otherwise successful replay.

## Diagnosis

Response-schema cache hits had two decoding paths. Stream replay passed through
`coerce_cached_llm_payload`, while the direct activity cache-hit branch in
`set_response_schema_activity` read `cached.title` and persisted it unchanged.
The saved July fixture's `Task Output` placeholder was therefore accepted as a
real title at the first bad boundary, bypassing the normalization used by the
stream path.

The deepest owned cause was duplicated interpretation of the same cached schema
payload. One path treated a generic placeholder like missing data; the other
treated it as authoritative agent identity.

## Solution

Both replay paths now call `meaningful_response_schema_title`. It preserves a
real cached title, treats `Task Output` as missing, and derives `Creator Brand
Strategy` from the mass-agent schema fields. The direct activity continues to
persist the title through the existing `generated_title` boundary.

The checked-in LLM blackbox supplies a cache hit with `title=Task Output`,
asserts that no live Rose schema call occurs, and requires both the activity
result and saved request body to use `Creator Brand Strategy`. With the helper
call temporarily removed, the exact command
`python tests/blackbox/llm.blackbox.py` failed at
`set_response_schema_activity_replaces_cached_task_output_title`; restoring the
helper made the identical command pass. The mass-agent benchmark now also
declares an `agent_task_title` static check against the owning `agent.title`
field and forbids `Task Output`.

Final-code benchmark run `5df83f8e-3705-4b9a-b746-1884026759a9` passed
that declared title check and every other criterion with 51 agents, 264
messages, 100% Fast Mode cache hits, and zero agent cost. Its durable viewer was
verified at
`https://www.roselabs.ai/?agent-id=2e15fec3-fe6e-449f-838c-a0a00cfec081`.

## Human feedback

The human required the task name to be sensible instead of `Task Output` and
required that behavior to be part of the benchmark's validation criteria.

## Reusable lesson

Normalize cached identity metadata once and apply it on every replay path before
persisting user-visible names.
