---
id: 2026-07-23-provider-cache-affinity-not-scoped-to-one-sequence
date: 2026-07-23
title: Provider cache affinity was not scoped to one logical sequence, so sibling explore tasks evicted each other's prompt cache
surface: cross
component: provider-cache-affinity
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: provider routing/usage identity — routing namespace, Codex affinity headers, and persisted usage did not all carry the same logical-sequence identity
symptoms:
  - sibling explore tasks evict each other's prompt cache
  - one-shot web summaries pollute the repeatable-cache ratchet
  - cache hit rate collapses across concurrent tasks in one agent tree
tags:
  - prompt-caching
  - cache-affinity
  - explore-agent
  - codex
  - fast-mode
sources:
  - PR #856
repro: cache-sequence regressions across provider routing/usage identity and structured-write key isolation
status: fixed
---

## Problem

Cache affinity leaked across logically independent work: concurrent sibling
explore tasks evicted one another's prompt cache, and one-shot web summaries —
which by definition are never reused — polluted the repeatable-cache ratchet that
measures cache health. The result was cache hit rates that neither reflected nor
rewarded real prefix reuse.

## Diagnosis

Cache identity was not carried consistently end to end. The routing namespace, the
Codex affinity headers, and the persisted usage record each derived their identity
differently, so two calls that belonged to the same logical sequence could land in
different cache scopes, and two calls from _different_ sequences could collide in
the same scope. Structured Fast Mode writes did not include the sequence in their
cache key at all. Because Temporal activity dispatch, DAG parameter population,
verifier, final-verifier, summarizer, context-compression, and approval paths each
re-derived identity, the sequence was lost at whichever hop forgot to propagate it.
The deepest owned cause is a missing single identity that every hop must carry —
not a defect in any one call site.

## Solution

Scoped provider cache affinity to one logical sequence end to end: the routing
namespace, all Codex affinity headers, and persisted usage now carry the same
identity, so sibling explore tasks cannot evict each other and one-shot web
summaries cannot pollute repeatable-cache ratchets. Structured Fast Mode writes
include the sequence in their cache key, and the Temporal activity, DAG parameter
population, verifier, final-verifier, summarizer, context-compression, and approval
paths all preserve it through usage accounting. Cemented by cache-sequence
regressions covering routing/usage identity, structured-write key isolation,
Temporal activity propagation, DAG parameter population, verifier/final-verifier,
summarizer/context-compression, approval flows, stable same-task and isolated
sibling explores, unique one-shot summaries, and fail-closed positive ratchets. The
merged head's smoke run measured 48.5% aggregate cache hit (browser biometrics
68.8%, spawn sub-agents 45.6%, browser smoke 46.1% repeatable-cache hit).

## Human feedback

None recorded.

## Reusable lesson

Prompt-cache affinity needs one logical-sequence identity propagated through every
hop that routes, writes, or accounts for a call — otherwise concurrent siblings
silently evict each other and one-shot work corrupts cache metrics.
