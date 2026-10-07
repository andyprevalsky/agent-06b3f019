---
id: 2026-10-06-hub-store-aggregated-independent-projections
date: 2026-10-06
title: Hub storage accumulated independent projections beyond the module size contract
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/benchmarkHubStore.ts combined object I/O, public types, and campaign projection inside the transactional persistence module
symptoms:
  - "File has too many lines (1033). Maximum allowed is 600"
  - "693:1 error max-lines"
tags:
  - benchmark-hub
  - module-boundaries
  - eslint
sources:
  - commit 6914a953f896eccc52bd328a698c501e3bc76a97
repro: back-end/scripts/lint-affected.mjs
status: fixed
---

## Problem

The normal deployment ESLint mutator exited 1 after 30.786 seconds on the
clean committed checkpoint. Its sole error counted 1,033 lines in the Hub
provider against the existing 600-line contract. Formatting and linting had
changed no source. The original receipt and log remain private under
`.context/fresh-basic-claude-final50-20261006/deploy/eslint-fix.*`.

## Diagnosis

The provider owned the shared transaction and persistence boundary, but also
contained the independent object-store adapter, public data contracts, and
campaign validation/projection. Adding group projection increased an already
combined owner rather than respecting those boundaries. The deterministic
linter reproduces this structural defect without model or provider calls.
Moving only object I/O, types, and grouping initially left 604 counted lines;
that unchanged rejection is retained as `repair-lint.*`. Task normalization
belongs with summary projection, so it moved with that responsibility rather
than compressing code or changing the size rule.

Archive searches used the literal max-lines error and the behavioral
"Hub provider module combines storage group projection oversized lint boundary"
query, plus exact text searches for module extraction. The prior Hub admission
and partial-publication cases share the owner but concern concurrency, not
this module-boundary defect. Their Solution and Human feedback were read;
their transaction and revision-ordering contracts remain intact. This is a
new structural incident, not a recurrence of those runtime failures.

## Solution

Object I/O lives in `benchmarkHubStorage.ts`, contracts in
`benchmarkHubTypes.ts`, and task/group projections in
`benchmarkHubRunProjection.ts`. The original module remains the public facade
and transaction/persistence owner. The storage sibling retains the same
directory, local isolation, Render identity, R2 configuration, strict missing
object behavior, and atomic local writes. Reset delegates to the adapter.
No runtime bounds or lint exceptions changed.

The grouping and admission controls now include actual reachable declarations
from the projection sibling. Behavioral assertions are unchanged. The source
structure control follows async filesystem operations to the storage owner.
Its deletion-order check also used the previous single-run variable names;
it now identifies the committed per-child read/tombstone expressions and
requires each expression to exist before comparing their order. It continues
to require bundle validation before tombstoning and tombstoning before catalog
removal.

The final focused grouping control passes all six tests. Hub admission and
resolution controls pass, and all five public committed-publication, failed
publication, and retry/coalescing controls pass against the existing owned
local PostgreSQL. Object storage is mocked in that control; it performs no
external object writes. Parent review compares original top-level declaration
tokens across the extracted modules: 54 of 55 original declarations are
identical ignoring trivia and leading exports; the only changed declaration
delegates test reset, and no original declaration is missing. The final affected-
importer lint passes unchanged at the same 600-line bound in 66.716 seconds.
The complete normal deployment gates remain a separate required validation;
focused checks do not establish deployment completion.

The extraction adds no per-agent work or provider operations. At 10,000 agents,
lookup, grouping, publication, and admission behavior have the same complexity
and limits as the original declarations.

## Human feedback

The parent directed a coherent extraction preserving behavior and assertions,
explicitly rejected disabling the size gate or broad exceptions, and held the
fresh 50-copy proof until the repaired deployment checkpoint was stable.

## Reusable lesson

Keep storage adapters, data contracts, and projections separate from their transactional persistence owner while preserving its public facade and regression controls.
