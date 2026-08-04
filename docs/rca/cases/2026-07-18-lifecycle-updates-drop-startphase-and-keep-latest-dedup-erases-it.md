---
id: 2026-07-18-lifecycle-updates-drop-startphase-and-keep-latest-dedup-erases-it
date: 2026-07-18
title: cloud_agent lifecycle updates posted metadata without startPhase, and the FE keep-latest dedup by toolCallId erased the attribute after ~0.7s
surface: agents
component: cloud-agent-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the workflow's cloud_agent lifecycle updates rebuilt tool metadata without `startPhase`, and the FE dedups tool messages by `toolCallId` keeping the latest
symptoms:
  - prod `chat-lifecycle-ratchet` gate never green — 0 successes in the last 100 runs
  - '[data-tool-name="cloud_agent"][data-agent-start-phase="plan|execute"]' milestone never observed
  - "the chip's phase attribute only existed for ~0.7s"
tags:
  - cloud-agent
  - lifecycle
  - dedup
  - metadata
  - chat-lifecycle-ratchet
  - deploy-gate
sources:
  - PR #792
  - memory:project_ratchet_startphase_erasure
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

The prod `chat-lifecycle-ratchet` gate had zero successes in its last 100 runs
and blocked Step 13b of every `/deploy`. The route milestone waits for
`[data-tool-name="cloud_agent"][data-agent-start-phase="plan|execute"]`, but that
attribute was present for only about 0.7 seconds. Prod DB evidence: for every
cloud_agent `toolCallId`, `startPhase` is set on the first row and `NULL` on all
follow-up rows.

## Diagnosis

The chat handler stamps `startPhase` onto the initial "Creating Cloud Agent"
message. The workflow then posts follow-up lifecycle updates (Preparing →
Starting Reasoning → Ready) that rebuild the tool metadata _without_
`startPhase`. The frontend dedups tool messages by `toolCallId` and keeps the
latest, so the first follow-up silently overwrote the attribute the gate depends
on. Neither half is wrong alone: a partial metadata update is only destructive
because the consumer's merge rule is last-write-wins rather than a merge. The
owned defect is that lifecycle updates were allowed to be partial while the
dedup contract treats each update as complete.

## Solution

`_find_cloud_agent_lifecycle_tool_call_id` now captures the pending row's
`startPhase`, and every lifecycle update carries it forward, so each posted
metadata payload is complete under the keep-latest dedup rule. The change is
Temporal-deterministic-safe: no new activities and no command reordering.
Cemented by `wf_cloud_agent_lifecycle_start_phase` in
`agents/tests/blackbox/workflow.blackbox.py` (fails pre-fix with
`KeyError: 'startPhase'`), which runs in the agents blackbox suite on deploy
Step 4g. Pre-existing import-sort lint debt in the touched file was cleaned up in
the same change.

## Human feedback

The remaining ratchet flake mode — occasional >5s latency outliers on
`direct_answer`/`web_search` prod samples — was explicitly left out of scope, and
the PR records that ratchet budget changes require explicit approval per repo
rules rather than being relaxed to make the gate green.

## Reusable lesson

If a consumer dedups by key and keeps the latest write, every producer update
must carry the full metadata payload — a "partial update" plus last-write-wins
silently deletes fields.
