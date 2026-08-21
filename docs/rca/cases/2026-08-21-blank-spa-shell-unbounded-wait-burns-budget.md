---
id: 2026-08-21-blank-spa-shell-unbounded-wait-burns-budget
date: 2026-08-21
title: Blank Vite SPA shell plus unbounded wait loops burned ~213s before checkout
surface: agents
component: spawn-browser-navigation-ready
classification: our-bug
problem_class: other
first_bad_boundary: wait_for_navigation_ready — one 3s blankSpaShell reload then hands empty #root to the model; early Document/Script network not captured so mount failure is unproven
symptoms:
  - "Navigation produced blank SPA shell; reloading once"
  - "Page still lacked usable content after reload"
  - "rootChildren\":0"
  - "blankSpaShell\": true"
tags:
  - blank-spa
  - vite
  - test-payment
  - navigation-ready
  - gate-subscription
sources:
  - agent b7b53dfb-20b4-4b8e-b019-432a315cee83
  - PR #1021
  - fleet run descend-20260820T202555Z-gate-sub
repro: none-recorded
status: open
---

## Problem

On gate-subscription-card-mint-admin-bypass pass@5, agent
`b7b53dfb-…` took **293s to request a payment card** vs a **~81s median** for
the four passing siblings (~**213s wasted** before checkout). Checkout after
card (~77s) matched pass agents. The waste window is filled with
`blankSpaShell` / `rootChildren: 0` evaluates and model `wait` loops
(announced wait budget ~448s), not mint/pay thrash.

## Diagnosis

Proven waste mechanism:

1. Kernel browser lands on Vite HTML with empty `#root` (`blankSpaShell: true`).
2. `wait_for_navigation_ready` waits ~3s, reloads once, still blank, returns
   not-ready (all five agents hit this; four recovered within ~30–50s).
3. Fail agent stayed `rootChildren: 0` through evaluates at t+139s and t+221s;
   card only at t+293s.

Not proven (capture gap): **why** `main.tsx` failed to mount for this
session. Redacted network indexes contain only late `Fetch`/`Other`
(Amplitude + confirm) — zero `Document`/`Script`/`main.tsx` rows — so we
cannot binary-search Vite/ngrok/module-graph vs Kernel. Console shows no app
JS error (preload warnings + Turnstile extension noise only).

Archive searches: `blankSpaShell Navigation produced blank SPA shell
rootChildren`, `vite main.tsx empty root appRootReady false test_payment`,
`Page readiness timeout blank SPA reload once`. No closed case for Vite
non-mount under Kernel+ngrok; relatives are empty-shell / readiness-timeout
classes. **Novel + open** on the mount cause; waste magnitude is owned by
unbounded post-reload waiting.

## Solution

Not fixed. Needed before claim: (1) capture Document/Script (esp. `/src/main.tsx`)
during blankSpaShell windows; (2) local repro of persistent blank mount; then
harden remount (bounded retries) and/or stop handing endless waits to the model
after a failed blank-SPA reload. Do not raise the 360s task timeout.

## Human feedback

User asked how much time was wasted and for /rca of that waste (distinct from
the post-pay PAUSE race).

## Reusable lesson

When a run burns minutes before first productive UI, measure blankSpaShell
duration first — and if network traces omit Document/Script, treat the mount
cause as a capture gap, not a guessed infra story.
