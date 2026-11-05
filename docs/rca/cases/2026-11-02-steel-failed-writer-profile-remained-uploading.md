---
id: 2026-11-02-steel-failed-writer-profile-remained-uploading
date: 2026-11-02
title: Steel writer failed while its persisted profile remained uploading
surface: back-end
component: steel-profile-persistence
classification: third-party-failure
problem_class: other
first_bad_boundary: Exact profile stayed UPLOADING after writer release path returned; later native SDK read showed the matching writer failed
symptoms:
  - Steel profile is not ready (UPLOADING)
  - Failed to create Steel replacement after 5 attempts
tags:
  - steel
  - profile
  - provider-outage
sources:
  - commit 05449cd2d44b879ec883cfd24aa2a9430da8a811
  - plan:/project/rose-speed-comparison-20261028/nov2-steel-rca/HANDOFF.md
  - plan:/project/rose-speed-comparison-20261028/nov2-steel-rca/native-sdk-status.json
repro: cd back-end && bash scripts/run-blackbox-tests.sh browser-provider
status: open
---

## Problem

The live rotation ladder passed Kernel-to-Steel transition and then failed Steel-to-Steel call four. The exact persisted profile remained UPLOADING across 20 reads in four requests over 40.027 seconds. Original backend coverage recorded 239 passing domains and one failure; all 350 unit files and the separate browser FPS probe passed.

## Diagnosis

The production release-first path returned before profile readiness was checked. No replacement session was created while unready. Native release acknowledgement is absent from the original logs, so its underlying failure is not reconstructed. At 17:34:47 UTC the installed Node SDK read the exact profile successfully: still UPLOADING, with identical creation/update timestamps at 17:27:39. The next successful native read showed its matching writer session failed. This supports an unavailable profile-persistence operation; it does not establish a global Steel outage or a specific underlying provider cause. Earlier Python lookups returned 403 and remain diagnostic gaps, not native state evidence.

Literal and behavioral archive searches found related October 14 release-order and October 16 readiness-guard cases. The release-first guard is present here; this is not proven recurrence of their original bug. A later independent Steel auth-persistence check passed and does not clear this failed profile.

## Solution

Candidate mitigation only: a test-only, explicit incident override requires the retained exact failure and successful native SDK evidence, then reports call four and its dependent exhaustion assertions as SKIPPED / parity incomplete. All preceding assertions, separate provider cases and final cleanup remain. Production readiness, custody and retry behavior are unchanged. No generic UPLOADING classifier, longer timeout or fresh paid control is introduced.

The permanent offline controls reject healthy, foreign, missing, early, unauthorized and inconsistent evidence. Integrated owner verification remains pending before the mitigation is accepted. The failed live operation remains preserved, not regraded as passed.

## Human feedback

The user authorized explicit provider-outage skips with final disclosure. Preserve the original failure and exact scope; do not conflate unrelated Kernel or Tilion overrides with this Steel operation. Keep the source frozen during existing gates, preserve Freedom and native resource ownership, and make no financial mutations.

## Reusable lesson

Bind an outage exception to native evidence and an explicit operator decision. Keep partial coverage visible and preserve production fail-closed state when a writer or persisted profile is unhealthy.
