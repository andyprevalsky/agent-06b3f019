---
id: 2026-07-08-missing-codex-fast-cache-proxy-warned-and-ran-live
date: 2026-07-08
title: Read-enabled Codex Fast Mode warned and silently ran live when no proxy URL was configured
surface: back-end
component: codex-fast-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "back-end Codex code-agent launch — Fast Mode reads enabled with no Codex proxy URL only warned, then continued live"
symptoms:
  - "E2B logs contain no `Codex Fast Mode proxy listening` line"
  - "task events contain no `fast_cache_proxy_started` or `fast_cache_proxy_request`"
  - a stalled content-calendar run shows large live OpenAI traffic instead of cache replay
  - recent fast-cache rows are only smoke/test entries, never the run's own trajectory
tags:
  - fast-cache
  - codex
  - e2b
  - silent-fallback
  - fail-fast
sources:
  - PR #728
repro: back-end/src/tests/unit/fast-cache-code-agent.test.ts
status: fixed
---

## Problem

A stalled content-calendar run was supposed to replay through the Rose Codex
fast-cache path and did not. The evidence was all absence: no
`Codex Fast Mode proxy listening` in the E2B logs, no `fast_cache_proxy_started`
or `fast_cache_proxy_request` task events, and the only recent cache rows were
smoke/test entries rather than the content-calendar trajectory. Codex usage did
show large live OpenAI traffic, but that was the provider's own prompt caching —
not Rose fast-cache replay — so the run had executed live the whole time.

## Diagnosis

The backend accepted a self-contradictory configuration: Codex Fast Mode reads
were enabled while no Codex proxy URL was set. On that path it logged a warning
and continued live instead of refusing to start. Because the fast-cache
configuration was also never logged before the E2B launch, the degradation left
no positive signal — proving it required reconstructing the run from four
independent sources of missing evidence. The deeper owned cause is the
warn-and-continue fallback: it made an invalid config indistinguishable from a
working one.

## Solution

Log the Codex code-agent Fast Mode cache configuration before the E2B launch, and
fail fast when Fast Mode reads are enabled but no Codex proxy URL is configured —
that combination is now an invalid configuration rather than a warning. Added
structural unit coverage (`back-end/src/tests/unit/fast-cache-code-agent.test.ts`,
`fast-cache-flag.test.ts`) so Codex cannot silently run live when Fast Mode is
expected.

## Human feedback

None recorded.

## Reusable lesson

A mode that "warns and continues" on missing infrastructure makes its own absence
unprovable — make the contradictory config fail fast and log the resolved config
before launch.
