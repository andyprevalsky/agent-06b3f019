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

## November 8 finite-literal-alternation follow-up

Full55 on `42cba2eca4305fad76ceda8d9721550e8afa7833` rejected the
public `data-google-sources` pattern `Project Sync|Lease`: HTTP400 instead of200.
The retained server trace took1004ms before search or provider refresh. The
specific analyzer failure (warmup, worker, unknown or throw) remains UNKNOWN;
no host-load or disk cause is established. The original native backend result
also contains a distinct teardown failure and coverage UNVERIFIED. Those facts
are not repaired or credited by a pattern proof.

Two archive searches used `Project Sync Lease INVALID_PATTERN` and
`finite literal alternation safety analyzer deadline`. This case is the same
local-proof scheduling boundary, extended to a previously excluded grammar;
`2026-11-08-grep-regex-safety-blocked-event-loop` is related but concerns a
synchronous analyzer, whereas this run uses the asynchronous implementation.
The original proof deliberately left every top-level alternation analyzer-owned.
A finite union of literal strings needs neither nested backtracking nor a
schedulable analyzer, yet this safe family still depended on one.

A new permanent owning function tests generic finite literal unions at zero
analyzer budget, including the exact public pattern. The identical focused
command failed on the original implementation (`false != true`) and passed
with the conservative proof. All existing assertions remain unchanged. The
proof scans every branch, accepts at least two nonempty literal-only branches,
handles explicitly escaped metacharacters and pipe/backslash parity, and rejects
any unproved branch, groups, classes, repetition, assertions or unknown escapes.
The existing1000-character cap, explicit analyzer seam, deadline, retries and
fail-closed fallback remain intact. The flags alphabet restriction is not a
standalone flag-syntax validator; production constructs valid flags before safety.

Exact diff, security reasoning, RED/GREEN commands and supervisor receipts are
preserved at
`.context/rca-google400/42cba2e-final-validation/finite-alternation-candidate/`.
Diff SHA256 is
`7cb6f8d70b40c5de93268c4e1a27b88915f6f120c2ca624f9425351841be889a`.
Independent review CLEAR is scoped to that two-file change. After integration,
the full canonical regex unit command passed, native0, with quiescent supervisor,
no orphans or signals. The ordinary backend domain/full gate still needs a new
normal run; this follow-up supplies no benchmark or production acceptance.
No new human feedback specific to this follow-up was recorded.
