---
id: 2026-09-10-gemini-explicit-breakpoint-pinned-short-prefix
date: 2026-09-10
title: An explicit Gemini cache breakpoint pinned every growing conversation to a sub-minimum opening prefix
surface: agents
component: rose-waterfall-prompt-cache
classification: our-bug
problem_class: other
first_bad_boundary: agents/providers/rose/waterfall.py build_openrouter_body injected explicit cache_control into Gemini 2.5+ requests that should use implicit growing-prefix caching
symptoms:
  - "parallel-tool-calls repeatable prompt-cache hit was 23.4%, below the hard 30% ratchet"
  - "18 Gemini explore calls reported cache_read=0 and cache_write=0"
  - "prompt size grew from 1491 to 39998 tokens while the explicit cache boundary stayed on the short opening pair"
tags:
  - prompt-caching
  - gemini
  - openrouter
  - cache-control
  - waterfall
sources:
  - agent 1bad2b70-0129-4619-9e39-2f3184e65aee
repro: agents/tests/blackbox/rose.blackbox.py::test_build_openrouter_body_leaves_gemini_prompt_caching_implicit
status: open
---

## Problem

The `parallel-tool-calls` deploy smoke completed functionally in 142.2 seconds,
but its repeatable provider prompt-cache hit rate was 23.4%, below the hard 30%
ratchet. Retained worker logs showed that all 18 `google/gemini-3.6-flash`
explore calls reported both `cache_read=0` and `cache_write=0`. The three
logical explore sequences kept byte-identical opening messages and tool schemas
while their full prompts grew from roughly 1.5k to 40k tokens.

The critical path was `run_agent cache_sequence_id -> Rose client -> OpenRouter
waterfall body -> Gemini cache selection -> usage accounting`. Two archive
searches used `repeatable prompt-cache hit below hard ratchet OpenRouter Gemini
zero cache read` and `Gemini explicit cache minimum stable prefix too short
cache_control first user zero reads`. The provider-affinity case from 2026-07-23
was related, but this was a different first-bad boundary: sequence identity and
sticky routing were present here, while the cache candidate itself was pinned
too early.

## Diagnosis

`build_openrouter_body` applied an explicit `cache_control` marker to the first
system message and, for sequenced calls, the first user message. Gemini uses
only the last explicit marker, so every turn selected the same roughly
2.5k-character opening pair even though Gemini 2.5+ supports implicit caching
over stable growing prefixes. That candidate was below the model's cacheable
prompt minimum. This is the only owned request-shape difference left after
confirming correct `session_id`, stable message prefixes, stable tool schemas,
and a sub-minute call sequence; the unchanged live smoke rerun remains the
decisive outcome proof that removing the synthesized marker restores reads.

The deepest owned cause is a provider cache-policy mismatch: a shared transform
treated explicit-breakpoint and implicit-prefix providers alike. The taxonomy
has no dedicated provider-cache-policy bucket, so this case uses `other`.

## Solution

The candidate fix keeps `session_id` sticky routing but disables synthesized
per-block cache breakpoints for Gemini models, leaving their stable growing
message prefixes to implicit caching. Caller-supplied breakpoints remain intact,
and explicit-cache models retain the existing transform. The permanent Rose
blackbox reconstructs the captured Gemini request shape and rejects any
synthesized `cache_control`; it failed before the change and passes afterward.

The exact unchanged benchmark outcome is pending the parent deploy smoke rerun,
so this case remains open until the hard cache ratchet passes.

## Human feedback

None recorded.

## Reusable lesson

Do not force a fixed explicit breakpoint onto providers that can implicitly cache a growing append-only conversation prefix.
