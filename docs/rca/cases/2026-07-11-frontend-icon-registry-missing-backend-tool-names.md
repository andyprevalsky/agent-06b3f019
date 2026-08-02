---
id: 2026-07-11-frontend-icon-registry-missing-backend-tool-names
date: 2026-07-11
title: Backend tool names absent from the front-end icon registry silently fell through to the generic Info icon
surface: front-end
component: tool-message-icons
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the front-end explicit icon registry — it had no entry for metadata.toolName "message_person" (or 12 sibling names)
symptoms:
  - iMessage/message_person rows render with the generic Info icon
  - "13 backend tool names fall through to the generic icon"
  - completed messaging tool rows show no messaging icon
tags:
  - front-end
  - tool-icons
  - metadata-toolname
  - registry-gap
  - contract-test
sources:
  - PR #752
repro: front-end blackbox test asserting an icon for every backend-emitted tool name
status: fixed
---

## Problem

Completed messaging rows in the agent transcript rendered with the generic Info
icon instead of a messaging icon. The backend was emitting
`metadata.toolName: "message_person"` correctly; the UI simply did not
recognize it. Indexing every backend-emitted and persisted tool name showed 13
names in the same state.

## Diagnosis

The front-end resolves icons through an explicit registry keyed by
`metadata.toolName`, with a generic Info fallback for unknown names. Because the
fallback is silent and visually plausible, a missing registry entry produced no
error and no warning — it just degraded the row. The registry and the backend's
set of emitted tool names were two independently maintained lists, so every new
backend tool shipped a UI regression by default. The deepest owned cause is the
un-asserted contract between emitter and renderer, not the individual missing
key.

## Solution

Indexed all backend-emitted and persisted tool names, added purpose-built icons
for the 13 that previously fell through, rendered completed
iMessage/`message_person` rows with a messaging icon, and — the generalizable
part — cemented the emitter-to-renderer contract with a blackbox test so a new
backend tool name without an icon fails the suite instead of silently degrading.

## Human feedback

None recorded.

## Reusable lesson

A silent visual fallback hides a broken contract — assert that every name the
backend can emit has an explicit front-end mapping, rather than relying on a
default branch.
