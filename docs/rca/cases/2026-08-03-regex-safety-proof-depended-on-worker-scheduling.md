---
id: 2026-08-03-regex-safety-proof-depended-on-worker-scheduling
date: 2026-08-03
title: Safe model-generated regexes depended on a schedulable analyzer worker to avoid false rejection
surface: back-end
component: data-grep
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/data/regexSafety.ts fast proof covered literals and one wildcard but delegated ordinary atomic repetition to recheck
symptoms:
  - "Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards."
  - data-grep testRealisticPatternsAllowed expected HTTP 200 and received 400 INVALID_PATTERN
tags:
  - data-grep
  - regex
  - redos
  - recheck
  - worker-scheduling
  - false-positive
sources:
  - PR #924
repro: back-end/src/tests/unit/regex-safety.test.ts and back-end/src/tests/blackbox/data-grep.blackbox.ts
status: fixed
---

## Problem

The canonical backend blackbox passed the catastrophic-pattern and dialect
normalization cases, then `testRealisticPatternsAllowed` received HTTP 400 with
`INVALID_PATTERN` and `Pattern safety analysis did not complete`. The failing
loop did not include the current pattern in its assertion, so the exact member
is not recorded. A deterministic probe set the analyzer timeout control to zero:
six ordinary money, invoice, email, semver, phase, and bounded-ID expressions
all failed closed before the fix, while the existing single-`.*` proof passed.

## Diagnosis

Failing closed when a complex pattern cannot be classified is required because
Postgres regex backtracking ignores `statement_timeout`. The mistake was making
safe, common atomic repetition depend on `recheck`'s synchronous worker being
scheduled inside its one-second analysis budget. Under the full deploy load the
worker could return unknown/timeout, converting a safe model query into a 400.
The first bad boundary was the local proof's overly narrow grammar; the deeper
cause was coupling an easily provable safety decision to host scheduling.

## Solution

`regexSafetyProof.ts`, called by `regexSafety.ts`, now performs a conservative
linear scan over a narrow grammar.
It locally permits unbounded repetition and at most two small variable-bounded
repetitions (maximum 5) only for the explicit positive one-character class
forms used by the realistic queries. All other bracket syntax, wider ranges,
and more numerous finite ranges stay analyzer-owned because their constant
backtracking factor can still exceed the degree-two policy. Every later
repetition must have a provably disjoint character set or a mandatory delimiter disjoint from both repetitions;
otherwise the pattern is analyzer-owned. Only non-alternating finite groups may
be optional; variable repetition inside a group and all other group
quantification, wildcard repetition, backreferences, lookarounds, nested
groups, and top-level alternation remain analyzer-owned and fail closed on an
unknown result. The zero-timeout regression accepts the six realistic families
but rejects ambiguous counterexamples including `(a|aa){500}X`, three adjacent
`a{1,500}` ranges, `a+aa+a+X`, and stacked wildcards. The work is O(pattern
length), capped at 1,000 characters, requires no worker, database query, shared
lock, or global state, and therefore scales independently across 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Prove common safe input classes locally and reserve bounded external analysis for syntax whose safety actually requires it.
