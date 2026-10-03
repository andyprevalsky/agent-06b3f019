---
id: 2026-09-10-gemini-explicit-breakpoint-pinned-short-prefix
date: 2026-09-10
title: An explicit Gemini cache breakpoint pinned every growing conversation to a sub-minimum opening prefix
surface: agents
component: rose-waterfall-prompt-cache
classification: our-bug
problem_class: other
first_bad_boundary: agents/providers/rose/waterfall.py build_openrouter_body reused the generic opening-message cache breakpoint for Gemini instead of selecting a stable cacheable completed-tool prefix
symptoms:
  - "parallel-tool-calls repeatable prompt-cache hit was 23.4%, below the hard 30% ratchet"
  - "13 Gemini explore calls reported cache_read=0 and cache_write=0 in the confirming smoke"
  - "prompt size grew beyond 10k provider tokens while the explicit cache boundary stayed on the short opening pair"
tags:
  - prompt-caching
  - gemini
  - openrouter
  - cache-control
  - waterfall
sources:
  - agent 1bad2b70-0129-4619-9e39-2f3184e65aee
  - agent 5a69c0b2-08ab-4b72-b440-b264589bd8d3
  - PR #1302
repro: agents/tests/blackbox/rose.blackbox.py::test_build_openrouter_body_pins_large_gemini_completed_tool_prefix
status: fixed
---

## Problem

Benchmark run: `a381369b-6013-4aa2-964d-75e8fff2c321`.

The `parallel-tool-calls` deploy smoke completed functionally, but its
repeatable provider prompt-cache hit rate remained below the hard 30% ratchet.
The confirming retained worker logs showed that all 13
`google/gemini-3.6-flash` explore calls reported both `cache_read=0` and
`cache_write=0`. The three logical explore sequences kept byte-identical
opening messages and tool schemas while their full prompts grew beyond 10k
provider tokens.

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
system message and, for sequenced calls, the first user message. OpenRouter's
Gemini integration honors only the last explicit marker, so every turn selected
the same roughly 2.5k-character opening pair. That candidate was below Gemini
3's 4,096-token cache minimum. An intermediate change removed the marker under
the incorrect assumption that OpenRouter would expose Gemini's implicit cache;
the next live smoke still reported zero Gemini reads and writes. OpenRouter's
documented contract requires an explicit breakpoint for Gemini, so the real
request-shape bug was the location of the marker, not its presence.

The deepest owned cause is a provider cache-policy mismatch: a shared transform
treated explicit-breakpoint and implicit-prefix providers alike. The taxonomy
has no dedicated provider-cache-policy bucket, so this case uses `other`.

## Solution

The fix keeps `session_id` sticky routing and synthesizes one deterministic
Gemini breakpoint at the earliest complete assistant/tool-result batch whose
serialized prefix clears a conservative size floor. The boundary stays fixed
as append-only history grows, never splits a tool declaration from its results,
and yields to caller-supplied breakpoints. `skip_cache_write` suppresses only
synthesized markers. The transform deep-copies nested message content so cache
annotation never mutates the caller's retained history.

The permanent Rose blackboxes reconstruct the captured request shape, assert a
single fixed marker across appended turns, cover Gemini 2.5, caller-owned
markers, and `skip_cache_write`, and verify that input history is unchanged.
Verifier usage without its own provider cache identity is also no longer
backfilled into the execute sequence, preventing one-shot cache writes from
polluting the repeatability denominator.

The unchanged `parallel-tool-calls` live diagnostic passed in 198.9 seconds
with a 74.1% repeatable cache hit rate, above the 30% hard floor.

## Human feedback

None recorded.

## Reusable lesson

For OpenRouter Gemini caching, pin the one honored explicit breakpoint to an
eligible completed-tool prefix that remains stable as the conversation grows;
do not invent cache identities for unrelated one-shot verifier calls.
