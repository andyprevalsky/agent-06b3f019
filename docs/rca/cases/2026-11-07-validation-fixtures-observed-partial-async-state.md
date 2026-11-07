---
id: 2026-11-07-validation-fixtures-observed-partial-async-state
date: 2026-11-07
title: Validation fixtures observed partial asynchronous state before their assertions
surface: harness
component: async-fixture-synchronization
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The hydration fixture expired the first phase write before target provenance committed; the archive fixture budget included setup before its intended fetch states existed
symptoms:
  - Browser resume is still in progress instead of hydration outcome remains unknown
  - cloud_cleanup_archive_timeout_retains_only_completed_snapshots snapshot equality failed
  - Disabled admission-credit fixture admitted a joiner before the holder finished
tags:
  - async
  - fixtures
  - timeout
  - validation
sources:
  - commit fe73e70d270aa1d1a7bf05682381b83e61f6641f
  - commit fdfee715ea
  - commit 5d57dd83daa053857a901879487e54978fa708b8
repro: back-end/scripts/fixtures/browser-session-hydration-retry.fixture.cjs
status: mitigated
---

## Problem

PR1716 cycle20 retained three failed validation gates after its frontend coverage,
cloud smoke, semantics and live checks passed. The original native failures are
unchanged. Their exact scheduling is not reconstructed, so deploy attribution
remains UNKNOWN with repair assigned to the coordinator until complete reruns.

## Diagnosis

The browser-session fixture woke when beforeHydration first persisted the
hydrating phase. recordHydrationTargets subsequently rewrites the same request
with its original expiry. Expiring the row between these writes permits the
later provenance write to restore the future expiry. The follower then reports
in-progress rather than unknown hydration. The original registered domain failed
that exact assertion, while an unchanged isolated fixture passed: this is a
scheduling-sensitive prerequisite, not evidence to loosen the assertion.

The archive native failure logged no observation phase or completed IDs. An
unchanged owning module passed 85 tests. A controlled delayed-tree replay
reproduced the snapshot assertion with phase tree_fetch and no completed root;
a generic whole-loop stall did not reproduce it. This proves an unsequenced
fixture prerequisite, but does not establish that cycle20 used that interleaving.
That evidence gap is retained explicitly.

The third failure already has a main-branch repair: see
2026-11-06-credit-fixture-gate-raced-holder-allocation-under-load. A controlled
real-lane replay failed on the old source and passed on current main without
changing memory accounting, bounds or assertions. The original admission receipt
was not retained, so that replay does not retroactively assign its cause.

## Solution

The browser fixture waits for actual blocked destination navigation, after target
provenance commits, before expiring the durable lease. Its original unknown-state,
no-extra-create and custody assertions remain. Finally releases the held operation
and joins its leader. The corrected fixture and registered browser-session domain
pass against the isolated local PostgreSQL database; paid providers are controlled.

The archive test controls its loop clock within the case and advances the same
0.01-second deadline only after the intended pending fetches exist. Production
still owns timeout cancellation and snapshot retention. All retention, completion,
cancellation and unpublished-log assertions remain; dropping a completed snapshot
still fails the negative control. The owning module passed five consecutive runs,
and a real BlackboxResult prior-cancel/current-case sequence passed. This is a
test-only correction, not certified proof of the original native archive cause.

Evidence is retained under .context/rca-cycle20-20261107 and
.context/pause-rca/nov7-browser-session-domain-after.log. Independent review
confirmed the browser producer ordering and unchanged assertions. Complete
corrected-source deploy gates remain required; these local results grant no
full-gate, production or cleanup credit. No production runtime or task timeout,
concurrency, browser ownership policy, or canonical transcript is changed.

## Human feedback

The user requires completing /deploy. Preserve genuine failed outcomes and repair
their validation boundaries instead of treating a partial pass as completion.

## Reusable lesson

Wait for the state an assertion actually requires. An earlier phase marker and a
short wall-clock setup budget do not establish completed asynchronous work. Keep
missing native observations unknown while validating a controlled causal replay.
