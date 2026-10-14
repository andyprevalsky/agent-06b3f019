---
id: 2026-10-14-steel-profile-attachment-preceded-writer-release
date: 2026-10-14
title: Steel replacement attached a persistent profile before releasing its writer
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: recreateSession attempted same-profile session creation while the recorded persistent Steel writer remained live
symptoms:
  - "Profile is still uploading and cannot be attached to a session yet"
  - "Failed to create Steel replacement after 5 attempts"
  - "/rotate-proxy 500"
tags:
  - steel
  - persistent-profile
  - browser-provider
  - rotation
  - resource-custody
sources:
  - commit e576489611da771499791db3980d78a1db8c5c02
  - fleet run backend-coverage-failed-20261014-201031-4157177
  - plan:docs/plans/completed/rotate-ip-tool.md
repro: back-end/src/tests/blackbox/browser-provider.steel-profile-lifecycle.support.ts
status: open
---

## Problem

The frozen backend coverage browser-provider domain failed live Kernel parity at
its second rotation, after Kernel-to-Steel succeeded. Five inner creates repeated
across four outer retries returned native 409 for the same persistent profile.
The exact original native session was later read as released/user_requested,
with persistProfile true and the same profile ID. Native profile READY updated
1.823 seconds after the successful source close; READY later is not evidence
that a fresh rotation can attach its own still-live writer.

An independent unchanged canonical domain run at e576 reproduced the same
/rotate-proxy 500 and twenty native uploading rejections, while the separate
Kernel/Steel authentication persistence case passed. Its private artifacts are
rose-steel-profile-baseline/.context/live-provider-before (185722ms FAIL).

## Diagnosis

The first bad boundary is the replacement create, before old-writer release.
Steel's documented persistent profile is uploaded when its source session ends.
The code kept that source open while repeatedly trying to attach its profile;
retry duration could not change the ordering. This is an owned lifecycle defect,
not provider outage, missing credentials, profile deletion, or timeout tuning.
The installed SDK provides exact sessions.retrieve/create/release and profiles
create/list, but no native live full-profile capture/clone. Session context only
captures selected cookies/storage and is not equivalent to full userDataDir.

Two archive searches preceded repair: uploading/rotate-proxy and replacement
readiness/cleanup/allocation. Related cleanup cases were leads, not substitutes
for reproduction. Existing session-reaper durable ToolSideEffect coordination
was the reusable native pattern; no account-wide profile-list hot path was used.

## Solution

In the isolated repair tree, claim the task and resolved full-profile binding;
inspect and release only the exact recorded persistent Steel writer; then let
same-profile create admit readiness within the original five attempts. Preserve
profile/auth state, return truthful CLOSED on confirmed release without a
replacement, and ERROR for unresolved release. Native requests remain outside
short DB transactions. Exact owner/deadline row locking fences binding writes.
Persist candidate cleanup intent before creation and retain ambiguous allocation
custody; absence during a pending create cannot prove no later allocation.

The captured fixture is registered in the existing browser-provider suite and
uses zero external fetches. It covers failure boundaries, stale owners, the
post-check/pre-write takeover gap, invalidated profile resolution, durable
restart cleanup, ambiguous late allocation, and postcommit bookkeeping failure.
The earlier WIP canonical domain passed with exact native Steel-to-Steel same
profile attachment and released/deleted cleanup receipts. Final corrected live
verification and independent review remain pending; this case stays open.

## Human feedback

The user required source freeze, unchanged owning fail/pass verification, full
profile preservation, exact ownership and native cleanup, and no timeout/task/
prompt/evaluator changes. The agent initially inferred that the old native
session must remain active on replacement failure. Parent clarified that this
was an inferred constraint: release-first is allowed with truthful recoverable
state. Review rejected status-only exclusion, unfenced lease expiry, account-wide
profile scans, process-only candidate custody, and release404 as terminal proof.
No deploy adoption or new caller-visible error text approval is implied.

## Reusable lesson

Order full-profile replacement after its exact writer has ended, and retain resource custody until native terminal evidence discharges it.
