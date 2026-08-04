---
id: 2026-08-03-account-controls-owned-by-separate-fixed-overlays
date: 2026-08-03
title: Inspection account banner obscured run content at the global-control layout boundary
surface: front-end
component: top-right-account-controls
classification: our-bug
problem_class: other
first_bad_boundary: InspectionAccountBadge independently fixed a wide banner instead of joining the account-control rail
symptoms:
  - Inspecting User Account banner covers critical info
  - inspection account chip overlaps the run content
  - inspection account chip is not next to the top-right user chip
tags:
  - account-controls
  - admin-inspection
  - fixed-overlay
  - responsive-layout
  - frontend
sources:
  - agent local-codex-2026-08-03
repro: front-end/src/tests/blackbox/admin-agent-inspection.blackbox.tsx
status: fixed
---

## Problem

Opening another user's run as an admin rendered a wide amber `Inspecting User
Account` banner across the page. The supplied screenshot showed the banner
covering the run heading and metadata while a separate compact account pill
already occupied the top-right corner.

The pre-fix blackbox reproduction expected the inspection control to be owned by
the top-right inspection slot. It failed because the badge's parent was the
terminal layout, and source inspection showed `fixed left-1/2 top-16` on the
badge while the admin switcher separately used `fixed right-4 top-4`.

The exact pre-fix command was
`cd front-end && npx vitest run src/tests/blackbox/admin-agent-inspection.blackbox.tsx`.
It failed at `expect(badge.parentElement).toBe(top-right-inspection-slot)` because
the received parent was the terminal layout rather than the reserved slot.

## Diagnosis

The agent-detail response supplied the correct `inspection_context`, and the
terminal passed that context unchanged into `InspectionAccountBadge`. The first
bad boundary was therefore rendering, not the API or terminal state: the badge
turned one account identity into its own page-wide fixed overlay.

The independently fixed badge and switcher had no shared layout owner, so they
could not reserve space for each other or apply one narrow-viewport shrink
contract. This was a local account-control composition defect, not a general
claim about every fixed overlay in the application. Archive searches for the
banner text, fixed positioning, and top-right account-pill collision found no
prior matching case.

## Solution

`AppShell` now owns a single fixed top-right account-control rail. The admin
switcher participates in normal rail layout, and the inspection badge portals
into a reserved slot immediately to its left. The badge uses the existing
neutral pill styling, keeps only the primary identity visible, and exposes full
name, phone, email, and read-only status through a hover/focus tooltip.

Both real controls have explicit `min-w-0`, maximum-width, truncation, and
no-wrap contracts, so long labels remain within narrow viewports instead of
wrapping over page content. The fix also prevents future inspection/account-pill
collisions. Runtime work remains constant per viewer: only the selected run's
two controls are rendered, with no scan or DOM growth based on the total agent
count. The same focused command passed all three inspection tests after the fix.

## Human feedback

The human said the large inspection chip obscured critical information and
asked for it to be styled like the compact user chip and placed next to the
existing top-right chip.

## Reusable lesson

Give sibling global account controls one layout owner; never position each account pill independently with fixed coordinates.
