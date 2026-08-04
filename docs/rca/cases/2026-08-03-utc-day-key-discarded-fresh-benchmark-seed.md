---
id: 2026-08-03-utc-day-key-discarded-fresh-benchmark-seed
date: 2026-08-03
title: UTC day rollover discarded a fresh schema-matched local benchmark seed
surface: harness
component: benchmark-seed-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/local.py::_prime_local_seed_dump_from_shared_stack required the current UTC day filename even when the previous-day dump was fresh and schema-identical
symptoms:
  - "Isolated local benchmarks require a schema-matched seed dump; refusing a slow production cold-sync"
  - "Expected cache token: 8c27cf62e1abe4b698af89c10008798f3f507e89-20260804"
  - a healthy 20260803 dump became unusable immediately after midnight UTC
tags:
  - benchmark
  - seed-cache
  - utc-rollover
  - schema-hash
  - fixture
sources:
  - agent 4b636b8a-7198-45b1-ba22-b44531b5fcd2
  - agent b1e04ed4-cff8-4f41-ab96-a150dc06032f
  - commit ab9f8fcf3
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The exact AMC benchmark rerun failed before creating an agent even though a
fresh schema-matched seed dump already existed. The runner had materialized
`8c27cf62e1abe4b698af89c10008798f3f507e89-20260803.dump`, then UTC crossed into
August 4 and the isolated stack required the identical schema hash under a new
`-20260804.dump` cache key. With no current-day filename and no eligible shared
stack to prime it, the runner refused a slow production cold sync.

Archive searches for `Isolated local benchmarks require a schema-matched seed
dump refusing a slow production cold-sync` and `seed cache UTC midnight day
rollover missing dump` found the July 19 stale-baked-seed case. This incident is
a relative, not a recurrence: that case concerned a present but schema-stale dump
blocking remote-cache consultation; this case discarded a fresh schema-identical
local dump solely because the calendar key changed.

## Diagnosis

The critical path was `scripts/run-bench -> isolated stack startup -> current
schema/day seed path -> local seed priming -> database restore -> agent creation`.
The current-day dump check was false while the previous-day dump had the exact
required schema hash, a valid sidecar, nonzero contents, and age under 24 hours.
The first wrong decision was treating the UTC date suffix as a hard identity
boundary instead of a cache-freshness partition with a short rollover bridge.

The owning benchmark blackbox fixes time at 00:23 UTC, creates a 23-hour-old
previous-day pair for the repository's actual schema, and invokes
`_prime_local_seed_dump_from_shared_stack`. Loaded from the actual buggy commit
`f05ef3c91`, the unchanged test failed at the owning boundary because priming
returned false. The focused hardened suite also caught an intermediate fix by
failing with `promotion ignored the canonical publish lock`.

The green regression set proves the owning priming boundary promotes the valid
pair, waits behind the canonical producer/consumer lock, replaces a zero-byte
current pair, and rejects wrong-schema filenames, mismatched sidecars, stale or
future candidates, malformed paths, and attempts after the grace window. The
full benchmark blackbox runner passes with all three tests registered.

## Solution

`_prime_local_seed_dump_from_shared_stack` now derives the actual repository
schema hash, validates both files in a seed pair, and interoperates with
`scripts/lib/seed-cache.sh` through the canonical `<dump>.publish.lock` symlink
protocol. While holding today's publish lock, rollover promotion takes
yesterday's publish lock as a consumer, then validates the filename hash and
day, sidecar, nonempty dump, age, and first-two-UTC-hours grace window.

Promotion uses a unique temporary pair, a hardlink where possible with a copy
fallback, and atomic replacement under the current-day lock. Both the temporary
and published pairs are revalidated. An invalid current pair therefore cannot
mask a valid candidate, while a producer cannot be observed midway through
publication.

The exact owning repro passes unchanged, `scripts/tests/seed-cache-decision.test.sh`
is green at 24/24, the full benchmark blackbox runner passes, and Ruff passes.
The first post-fix AMC run used a current-day dump created by setup and therefore
was not promotion proof. For closure, the current-day pair was moved to a
recoverable backup and the exact unchanged AMC command logged
`Promoted recent previous-day benchmark seed dump`, restored the isolated
database, created agent `b1e04ed4-cff8-4f41-ab96-a150dc06032f`, and exposed a
valid frontend page for that agent. The run emitted
`20260804_005702_browser-event-ticket.json` after 421 seconds. The task then
failed at the independent `movie-ticket-runtime-contract` boundary because the
observed `spawn_browser_agent` tool ended `ERROR`; that later failure does not
invalidate the completed seed promotion, restore, agent creation, live-view, or
artifact path proved here.

This adds no production-agent hot-path work: it runs only during local benchmark
startup. With 10,000 same-host controllers, one schema/day pair is promoted
under its per-dump publish lock and warm callers perform O(1) pair checks;
contention is isolated to that cache key rather than serialized globally.

## Human feedback

None recorded.

## Reusable lesson

A date-partitioned cache needs a narrow, schema-verified rollover bridge so UTC midnight does not invalidate fresh immutable data.
