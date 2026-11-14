---
id: 2026-10-30-r118-cached-browser-focus-blocked-by-foreign-discovery
date: 2026-10-30
title: Known browser focus waits for unrelated tab discovery
surface: agents
component: browser-tab-focus
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: sequential Playwright Page discovery awaits an unrelated uncached Page before selecting a cached live focused Page
symptoms:
  - known focus blocked behind unrelated CDP attachment
  - recorder and humanizer cannot follow an already-known focused Page
tags:
  - r118
  - browser
  - tab-focus
  - cdp
sources:
  - commit 98c8668b47b5e9b2fd2b807c2f083f2e46a04733
  - plan: patch 08ee015ad8847b1a7ff6b9fa83626bd458c6ca90c6a63cd32f6ef943163e1988
repro: registered test_cached_tab_focus_ignores_unrelated_stalled_page with exact native helper and inert Page/CDP seams
status: open
---

## Problem

The browser's existing weak Page-to-target cache already identifies the live
focused Page. However, _synchronize_playwright_page_with_agent_focus scans
context.pages in their original order. An earlier unrelated uncached Page can
suspend new_cdp_session indefinitely before the known focused Page is visited.
This prevents the actual rebind helper from moving recorder and humanized input
to the requested target. It is independently reproducible without a model or
provider call.

This R118 mechanism is separate from R112's original It27 BU097r1/r2 stalls.
Those archives show partial target silence and no next model call, but lack the
exact suspended await/cache contents. Neither original attribution nor either
task outcome is established by this local reproduction.

## Diagnosis

Exact98c helper replay gives context [foreign, focused], a verified cache entry
focused->focus and current browser-use focus=focus. The foreign attachment
never settles. Baseline actual _rebind_browser_tab_runtime remains pending,
then the unchanged owning assertion fails. Test cleanup cancels the owner and
confirms cancellation propagation. No timeout or task threshold is altered.

The Page target cache is already populated by Target.getTargetInfo and keyed by
weak Page object identity. R118 does not introduce a new source of target IDs.
A cached entry is usable only for an open Page that is still a member of the
same current first context. Focus and membership can change across an await,
so they must be checked before accepting the selected Page.

## Solution

Applied on the descent branch after independent exact-snapshot review: prioritize an existing
cached focused Page over foreign discovery, preserving the prior discovery
path when focus is unknown. Check current context, Page membership/open state
and focused target before accepting a result, including after foregrounding.
A completed remote foreground call is not retracted if focus changes during
it; the stale result is not published as the accepted selection.

Frozen candidate08ee015a changes only handler.py and its registered blackbox
tests. Pinned Python3.11.9 actual run_all_tests baseline fails the new owning
assertion, while candidate passes three selected controls: the new cache/focus
control, existing full input/recorder/tab-focus behavior, and existing provider
keyboard transport preservation. Additional branches within the new control
cover uncached discovery/detach, closed/removed/other-context entries, changed
focus/context during discovery, post-foreground supersession and cancellation.
Compile and diff checks pass. Parent post-application registered controls also pass (3/3). The runtime repair is proved at its owning boundary; no original task PASS is claimed.

Independent reviewer returned GROUNDED for patch 08ee015ad8847b1a7ff6b9fa83626bd458c6ca90c6a63cd32f6ef943163e1988. Parent verified the two runtime/test output hashes and executed the same three registered controls on the applied checkout. Original R112 task attribution remains OPEN.

Exact review commands, using the supplied prepare.py to build isolated trees:

    python prepare.py /exact98c/agents /new/private/replay
    agents/venv/bin/python run_registered.py /new/private/replay/baseline
    agents/venv/bin/python run_registered.py /new/private/replay/tree

Personally opened analogs: Browser Use 0.13.11 `browser/session.py:1482-1555`
target-session pool lookup and active validation; OpenClaw
`extensions/browser/src/browser/chrome-mcp-routing.ts:386-400` leased target
mapping and `browser/routes/tabs.ts:270-292` current-tab checks; Hermes
`tools/browser_tool.py:342-367` last-active session ownership checks. Their
retries, external authority
or permissive legacy metadata are not imported. No timeout, credential,
actor/schema, progress, model or evaluator change is proposed.

## Human feedback

The user prioritizes native failures, zero progress and schema/validator data
flow while retaining all failures for investigation. This separate local defect
does not turn the original initialized progress zero into a verifier score or
justify changing either original R112 outcome.

## Reusable lesson

Use a validated known target before discovering unrelated targets. Keep the
mechanically reproduced ordering defect separate from an original incident
whose suspended-operation identity is missing.
