---
id: 2026-11-08-fresh-cycle-lacked-history-only-custody-admission
date: 2026-11-08
title: Fresh repair cycles lacked supported history-only custody admission
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The historical custody refresh API required an existing donor lineage and retained its attempts and waivers instead of admitting only indexed obligations into a pristine current cycle
symptoms:
  - A fresh repair cycle could not bind the two historical no-retry obligations without importing donor execution state
  - Full donor discovery initially refused omitted native evidence, correctly
tags:
  - custody
  - deploy
  - provenance
sources:
  - PR #1770
  - PR #1828
  - agent historical custody transfer repair
repro: python3 .context/c15-custody-import-regression.py
status: open
---

## Problem

The parent requires a fresh repair ledger with no donor PASS, skips, input
fingerprints, environment or READY. Existing prepare-historical-no-retry/refresh
validates a continuing lineage; even when no PASS is carried, refresh retains
the donor attempts and superseded waiver history. Copying donor READY or editing
JSON manually is not an acceptable fresh-state transfer.

Initial actual donor known() replay correctly raised original sandbox native
bytes missing or changed. These were export omissions, not benign incomplete
observations: the origin supplied supplemental exact native/lifecycle/audit
bytes, which the parent verified and admitted separately. Universal discovery
must stay unchanged. Financial snapshots remain historical, not current proof.

## Diagnosis

The first code-level compatibility gap is absence of a typed history-only
admission API. Literal archive searches used original sandbox native bytes
missing or changed; behavioral search used historical custody transfer fresh
state. The existing AgentCard release-stall and retained-worker custody cases
are relatives, not this transfer boundary. No provider failure was diagnosed or
repaired here. Source path: explicit pinned donor/index and fresh plan/state →
unchanged full known() → every indexed historical() closure → typed current
apply/verify/admission → one normal atomic state write.

The regression runs the same final owning tests against the original helper
loaded from Git, then the candidate helper. Original source fails all four
methods (one failure, three errors) because the typed import boundary is absent;
candidate source admits only the indexed duties. A separate permanent negative
removes an unrelated donor sandbox discovery native file and requires refusal;
restoring those identical bytes permits import. This preserves the observed
real evidence gap rather than teaching discovery to ignore it.

## Solution

Add prepare-historical-import and import-historical-custody actions. Require
explicit regular canonical donor/index files with caller-supplied verified raw
SHA256 pins; the pinned contents manifest must bind the canonical donor cycle.
Require quiescent donor discovery, nonempty complete matching active/history
indexes, distinct resource identities, original/resolved failure authority,
original source/catalog, native/adapter/audit bytes and absent owners. Replay
all existing historical() checks without changing known().

Only a state exactly equal to normal current initialize() may import. Current
source/plan/environment/fingerprints are genuine current inputs. Copy only the
validated indexed failures/history, their pending repair packets and donor
provenance. Existing apply/verify/admission supplies NO_RETRY_CUSTODY,
UNVERIFIED current execution/financial state and false credit booleans. Do not
copy donor attempts, skips, operational waivers or READY. Build/verify a private
candidate before the existing atomic write; exact replay is idempotent only
while the admitted ledger stays otherwise pristine. Later admission revalidates
the explicit donor pins and complete index, and request state identity includes
import provenance. All ordinary current checks still execute.

Operational commands and provenance prerequisites are documented in
`docs/deploy-test-cycle.md`. Tests stay in the existing deploy-test-cycle
suite, including CLI preparation/import/replay, child admission inventory,
partial/changed evidence, nonfresh/pending/mixed state and missing unrelated
native evidence. Existing native closure tests continue exercising corrupt
audits and active-owner refusal. Exact commands/results and source hashes are
in `.context/c15-custody-import-report.txt`; parent owns final review/freeze and
actual current-state invocation. Status remains open until parent integration
and normal deployment acceptance, not because the original C15 command failed.

## Human feedback

Parent is sole deploy coordinator. No manual ledger surgery, donor READY,
provider queries, historical requests, mint/reclaim/retry/release/refund, live
claims, credentials or Freedom changes. Both sandbox duties remain historical
4396c each and currently UNVERIFIED. The separate live100c production duty is
not a sandbox skip and grants no production lifecycle retry. The original C15
command already exited0 according to the parent; this additional compatibility
repair cannot waive any final-source or deployment gate. No new agents.

## Reusable lesson

Provide an explicit provenance-pinned history transfer for fresh coordinators;
continuation refresh and evidence restoration do not authorize importing old
execution credit. Missing historical native evidence must be restored exactly,
never bypassed by filtering discovery.
