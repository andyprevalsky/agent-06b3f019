---
id: 2026-11-06-fresh-browser-provider-overridden-by-recovery-preference
date: 2026-11-06
title: Fresh browser session uses Steel despite BROWSER_PROVIDER=tilion
surface: back-end
component: browser-provider-selection
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: createSessionWithContextUsingDependencies selected BrowserContext.preferredBrowserConfig.provider before the deployment default; logicalSession independently defaulted placeholders to Kernel
symptoms:
  - "Fresh browser session uses Steel despite BROWSER_PROVIDER=tilion"
  - "fresh session must use Tilion despite saved Steel recovery"
tags:
  - browser
  - live-view
  - proxy
sources:
  - agent 4f77a454-7ee9-449d-9803-175056487f9e
  - commit d16c934b7e19446d7069c7f76d8dd550b2058a96
repro: back-end/src/tests/blackbox/browser-fresh-provider.blackbox.ts
status: open
---

## Problem

Fresh browser session uses Steel despite BROWSER_PROVIDER=tilion. User requested RCA of the missing app browser view and unstable proxy location, plus Tilion as the default for fresh sessions.

## Diagnosis

Runtime: production Render BROWSER_PROVIDER is tilion and its Tilion key is present; rollout switches are unset. This user's context stored a Steel fixed-proxy recovery preference learned at 02:11:27.981 UTC for SAN FRANCISCO/CA/US. At 02:15:08 the reported root initialized on Steel with requested_provider=steel and no fallback reason. Later resumptions remained on that existing Steel binding.

What: fresh sessions use a learned provider instead of the requested default. Where: backend fresh-session dispatcher and logical placeholder creation. Why: deployment and learned recovery state both owned provider selection; placeholders also had a separate Kernel default. Proof: replaying the captured preference with Tilion selected fails `steel !== tilion` before the fix; the unchanged command passes after filtering preferences to the selected provider. The separate placeholder assertion failed `kernel !== tilion` before sharing DEFAULT_BROWSER_PROVIDER and respecting its rollout switch. Existing-row dispatch assertions retain Steel and Kernel. Problem: uncaptured user preference/spec, now explicit that fresh sessions default to Tilion.

Existing physical sessions retain their stored provider. The change does not force-migrate an active browser or remove provider rollout switches.

Critical path: backend session selection/binding → worker session events → persisted messages → app browser owner registration and metadata derivation → drawer selection/viewer and proxy chip.

Archive searches: `browser view blank debugUrl steel`, `proxy location fresh session preferred provider`, `No browser session pendingSwitch`, `proxy_source profile-only reattach`, and `preferredBrowserConfig default provider`. Relatives include the October 9 authoritative-session-binding case and October 23 logical-first-init case; their first-bad boundaries differ. No matching case for this exact boundary was found. This is a relative, not a demonstrated recurrence.

## Solution

Resolve the fresh-session provider first; apply learned proxy configuration only for that same provider. Use DEFAULT_BROWSER_PROVIDER for unmaterialized logical rows and align the independently configured account-connect/compute-grant default to Tilion. The domain config cannot import provider-layer code; the cross-domain regression enforces agreement. The account-connect default assertion independently failed `kernel !== tilion` before this change. Explicit domain provider overrides remain effective. Keep existing-session dispatch unchanged and preserve profile-bound sign-in handling.

Verification commands: `cd front-end && npx vitest run src/tests/blackbox/browser-drawer-session-regression.blackbox.tsx` and `cd back-end && npx tsx src/tests/blackbox/browser-fresh-provider.blackbox.ts`. Frontend: 2 failing assertions and 1 passing boundary assertion before, 3 passing after; later viewer-token/control-flag coverage adds three passing cases. Backend: preference and placeholder assertions each observed failing before their respective fixes and passing afterward. Original logs are retained privately in `.context/rca-browser-4f77/`. The existing frontend Vitest coverage discovery includes *.blackbox.tsx; backend blackbox run.ts discovers *.blackbox.ts automatically. The related five frontend files passed 55 tests, and the backend browser-provider contract suite passed 52 tests against an isolated localhost database; live provider checks were not executed by that invocation.

Delete/unify/guard assessment: preserve the existing single session owner and event stream; unify fresh selection with the deployment default and reduce deltas at their presentation owner. No extra polling, subscriptions, remote sessions or DB queries are introduced. At 10k agents these remain per-visible-task operations over the current binding's messages, with no shared-channel fan-in.

Golden reference: not applicable (no approval-gated hunk). No prompt or terminal/recovery semantics changed. Independent managed RCA investigation/review could not start: three identical attempts returned `delegation_service_unavailable`; no child was created. That platform issue was already reported in recent feedback. Deployment/review remain pending: GitHub credential acquisition hit its API rate limit and the staged deploy planner refused missing independent worker bindings; status stays open, and the original client timing and actual exit-IP placement remain unverified.

## Human feedback

The user explicitly requires Tilion as the default for every fresh browser session while preserving resumed sessions.

## Reusable lesson

Keep fresh-session selection, same-session event reduction and deferred UI registration consistent with the resource identity they actually own.

### Validation contract update

The first complete deploy sweep exposed legacy unit and blackbox fixtures that used learned preferences as cross-provider fresh-session selectors. Those expectations predate the user's requirement. Preserve their learned proxy, promotion, auth persistence, live CDP/viewer and cleanup assertions by selecting the same provider explicitly: same-provider unit dependencies and an owned local HTTP server mounting the production browser router with its real authentication middleware. The cross-provider auth test explicitly configures Kernel, Steel/Tilion, then Kernel for its three fresh calls. No production route or request schema is changed. The original failing browser-challenge-recovery and browser-provider domains both pass after this fixture repair; original logs and full native lifecycle evidence remain in the private deploy archive.
