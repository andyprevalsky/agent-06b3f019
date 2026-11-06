---
id: 2026-11-03-coderabbit-publication-bound-findings
date: 2026-11-03
title: A delivered CodeRabbit publication was rejected by the legacy verdict classifier
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: substantive_reviews required a legacy verdict phrase although the exact review had a native publication and review-bound finding
symptoms:
  - no substantive CodeRabbit review on 8d5d11b7aabf to override
  - coderabbit-review-publication v1
tags:
  - coderabbit
  - review
  - provenance
sources:
  - PR #1662
  - commit 8d5d11b7aabf2de8c0edf57a67d10ce9e0dd953c
  - agent CodeRabbit review 5747657344
  - agent CodeRabbit finding 4451247543
  - agent CodeRabbit check 125745366069
repro: python3 scripts/tests/deploy-review-cycle.test.py
status: fixed
---

## Problem

The canonical override command rejected a delivered exact-head review. Its
552-byte body contains a CodeRabbit publication-v1 marker and a fix-comments
checkbox, without any legacy verdict phrase. The review has a non-reply bot
finding bound to its review ID and both commit identities, and the exact-head
check completed successfully with title Finished. An empty reply wrapper or a
green check alone would not establish a delivered review.

## Diagnosis

The existing classifier recognized only actionable-comments, LGTM, no-actionable,
approved or reviewed wording. The untouched API evidence therefore produced no
substantive reviews despite the positive publication and finding bindings.
There was no supported alternative command. Editing the body or manually
closing the cycle clean would fabricate evidence or bypass the disposition.

## Solution

The shared classifier retains its legacy path and also accepts one complete
publication-v1 batch only when the native bot review, positive review ID,
review-bound non-reply bot finding, exact commit identities and latest completed
successful Finished check agree. Both override and usage-skip refusal use this
recognition. Override receipts preserve the publication IDs, finding IDs, check
ID and original review-body hash. No verdict wording or finding count is invented.

Marker-only, green-only, empty wrappers, incomplete batches and mismatched
review/head/bot/check proofs refuse atomically. Existing round limits, deferral
targets, answered-finding checks and all other policies remain intact. The
registered owning suite passed40/40, including the new fail-first controls.

With the untouched real review evidence and proper typed replies, the canonical
override returned0 at2026-11-03T06:11:02Z for the original8d5 head. Its row is
Overridden, with finding4451247543 deferred to the real follow-up branch and
issue1676 under the standing three-round authorization. This does not approve a
later source head, turn the finding into a fix, or waive a test/cleanup failure.

## Human feedback

No new human approval was requested or inferred. The existing deploy policy
already authorizes eligible finding deferral after three delivered rounds.
Parent coordination required exact evidence recognition and prohibited manual
clean closure, body fabrication and policy relaxation.

## Reusable lesson

Recognize a review through its native publication provenance when presentation
wording changes; preserve the safeguards that distinguish real delivery from
reply wrappers and false-green checks.
