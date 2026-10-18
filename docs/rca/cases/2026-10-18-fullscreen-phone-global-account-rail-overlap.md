---
id: 2026-10-18-fullscreen-phone-global-account-rail-overlap
date: 2026-10-18
title: App-shell account rail overlapped native phone pixels outside fullscreen layout
surface: front-end
component: top-right-account-controls
classification: our-bug
problem_class: other
first_bad_boundary: AppShell fixed global rail did not participate in browser fullscreen header layout
symptoms:
  - Global account pill covers physical phone OS status bar on mobile
  - Component preview passed while full-app phone pixels were occluded
tags:
  - cloud-iphone
  - fullscreen
  - account-controls
  - responsive-layout
sources:
  - agent 49e6acd8-e821-4121-9a18-ccb035d0b0c9
  - hub run a539faa3-74c9-47c0-80b1-d37119c71400
  - agent local screenshot .context/phone-harness/goal5-live-view/mobile.png
repro: front-end/src/tests/blackbox/fullscreen-global-controls.blackbox.tsx
status: fixed
---

## Problem

The unchanged canonical phone task already PASSED at
05351394c7c7f1295579e314b28781d270c28604, run
a539faa3-74c9-47c0-80b1-d37119c71400: controller exit 0, 146.4 seconds,
42 messages, phone cleanup 2/2 and stack released. This is a product layout
incident, not a benchmark failure or model failure. No task definition,
criterion, prompt, provider operation, or benchmark result was changed.

The actual full-app mobile screenshot in
`.context/phone-harness/goal5-live-view/mobile.png` shows the app account pill at
x246/y64 over the phone OS status bar. Its accompanying `proof.json` records
successful first-party authenticated PNG observations (750x1334), zero phone
writes, and zero observation errors. The prior component preview lacked the
actual AppShell account rail, so its successful geometry did not cover this
composition boundary.

## Diagnosis

Path: valid private phone PNG -> existing fitted phone pane -> browser fullscreen
header -> AppShell global controls. The PNG and phone fit were correct. The first
bad boundary was the final composition: the fixed rail used ordinary terminal
page offsets while fullscreen content began immediately below its own header.
Those two layout owners reserved no space for one another.

Archive searches executed before the fix:
`python3 scripts/rca_archive.py search 'account controls fullscreen overlap'`
and `python3 scripts/rca_archive.py search 'TopRightControls inspection ownership'`.
Read case `2026-08-03-account-controls-owned-by-separate-fixed-overlays` and
`docs/rca/process-feedback.md`. This is a relative, not the same first boundary:
the older defect had separate fixed badge/switcher owners; this incident already
had the correct single owner, but that owner's fixed position ignored fullscreen
layout. Preserve the older portal and single-owner contract.

The owning normal frontend blackbox renders actual AppShell, actual account
switcher (non-admin impersonation state), actual inspection badge, and actual
fullscreen header. First command before implementation:
`cd front-end && npx vitest run src/tests/blackbox/fullscreen-global-controls.blackbox.tsx`.
Observed RED in `goal5-global-controls-red.log`: the fullscreen section did not
contain `top-right-controls`, which remained fixed at page coordinates. The
semantic containment assertion is retained. The fixture's later state-retention
checks use external open/close events to avoid deliberately invoking the
switcher's existing outside-click dismissal while testing host movement; an
initial click-based attempt correctly dismissed that menu and was not treated
as a product state-loss defect.

## Solution

AppShell still mounts exactly one TopRightControls/AdminSwitcherMount subtree.
A client-only layout provider registers mounted fullscreen header slots. The rail
uses one persistent portal host, moved into the reserved header row while
fullscreen is open and returned to normal page placement on close. Its React
portal target never changes, preserving account-switcher state and the existing
inspection slot DOM identity. Both mobile and desktop reserve space in normal
flow, rather than painting over device pixels. No global-control hiding,
duplicate admin mount, blanket z-index, phone frame/input change, polling, or
new request was introduced.

The new owning regression preserves the same rail, inspection badge, open search
input node, and typed query across slot entry/exit; asserts read-only identity
and impersonation exit remain reachable; and checks that the header slot
precedes phone pixels. Existing structural rail ownership and account-switcher
blackboxes remain intact. Source comments document layout transitions.

## Verification and remaining gate

The focused command above is GREEN (1/1), recorded in
`.context/phone-harness/goal5-global-controls-green.log`. The first combined
account/inspection/structural gate passed 14/14; the final expanded seven-file
phone/admin/structural gate passed 41/41. TypeScript, ESLint (zero source warnings),
and Prettier checks passed. Exact results are recorded in the sibling `goal5-global-controls-owning`,
`-ts`, `-lint`, and `-format` logs.

Parent's real-component browser driver reported desktop1440x900, mobile390x844,
and small320x568 geometry passing: global rail above phone pixels, close control
disjoint, phone width >=150px after takeover, queue and same-browser restoration.
The exact driver log is `.context/phone-harness/goal5-global-controls-visual.log`.
Parent completed the augmented preview and exact driver on frozen source.
Final six cases cover own-account and combined inspection/impersonation states
at 1440x900, 390x844 and 320x568. All pass unchanged geometry, input, queue and
same-iframe restoration assertions; the root inspected both smallest mobile and
desktop combined-state screenshots. Final log:
.context/phone-harness/goal5-global-controls-inspection-visual.log.
The initial combined fixture omitted the restorable admin-session stash, so
getImpersonatedAccount correctly rendered own-account state. Root corrected only
the fixture custody to match the actual AppShell owning regression, retaining
all impersonation/exit assertions. An earlier Vite compile overlay during live
source edits was discarded as an invalid concurrent-edit observation.

Whole frontend coverage passes 169 files and 2833 tests, with 3 existing skips;
production build and development-preview ESLint pass. Final logs are
.context/phone-harness/goal5-final-frontend-coverage.log and
.context/phone-harness/goal5-final-frontend-build.log. The case is FIXED.

At 10,000 agents the layout still renders one viewer-owned rail and slots only
for mounted fullscreen headers; registration/unregistration follows DOM lifetime.
There is no per-agent iteration, subscription, polling, retained history, or
network amplification. Agent runtime behavior and the original native PASS are
unchanged. No new paid task or live phone operation was run.

## Human feedback

Keep the only impersonation exit reachable and inspection identity visibly
read-only; preserve the AppShell single-instance rail. Reserve fullscreen header
space rather than hiding controls or covering phone pixels with higher z-index.
Do not infer a benchmark failure from this layout defect.

## Reusable lesson

A single global-control owner also needs explicit fullscreen layout ownership.
Move its stable host into reserved space; preserve account state and identity
instead of covering content, hiding exit controls, or duplicating mounts.
