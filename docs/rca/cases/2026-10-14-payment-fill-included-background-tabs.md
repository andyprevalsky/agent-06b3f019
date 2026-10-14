---
id: 2026-10-14-payment-fill-included-background-tabs
date: 2026-10-14
title: Payment autofill wrote into a background checkout while reporting success on the active login page
surface: agents
component: browser-payment-fill
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py _iter_payment_fill_targets accepted every get_all_frames target without proving ancestry under the focused page
symptoms:
  - Auto-filled payment refs on handoff page
  - Built secret refs for type interception
  - Cross-origin handoff page
  - Submit the payment form on THIS page now.
  - approved payment-card fill changed the background checkout while the login tab was focused
tags:
  - payment-card
  - browser-agent
  - oopif
  - tab-ownership
  - agentcard
sources:
  - agent 389d96c6-4c8b-4729-a201-bbc73499f662
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_payment_ref_fill_isolated_to_focused_page_and_child_frames
status: open
---

## Problem

The user asked why card credentials were not returned while upgrading a newly
created ChatGPT account. The checkout amount was $500. The root is an ordinary
production agent (`isBenchmark=false`), archived at 17:57 UTC on October 14.
All 916 database messages, both approval-window worker logs and original
encrypted browser-resume artifacts were inspected. Private evidence stays in
the workspace; real passwords, PANs, cookie values and signed headers are not
fixtures in this case.

Credentials actually reached the browser. At 15:35:25.981012 and
16:30:40.026281 the worker logged `Browser payment card minted` with
`card_id=rose-agent-card-static`, last four 1372. Both resumed activities logged
`Built secret refs for type interception` with `card_refs_count=4`. Raw values
are intentionally held privately; the model receives `card_number`,
`card_name`, `card_expiry`, `card_cvv` reference names and a last-four summary.

In the second resume, successful PAN/expiry/CVV fills were logged against
CDP target 3C39EDD5B156 while the handler's current URL was the
platform.openai.com login page reached from a synthetic origin-storage URL.
At 16:31:16.875209 the handler logged successful autofill on
`handoff_host=platform.openai.com`. Its injected message attributed the fill to
that login page and instructed submission there. At 16:31:21 the browser
identified the mismatch: checkout was in another tab. The later return to
checkout observed `/auth/logout`.

## Diagnosis

Critical path: approval -> backend card result -> private resume card refs ->
semantic browser fill target discovery -> field mutation -> success result ->
current-page handoff message -> browser's next action.

The private card result is correct. The first proven incorrect owned boundary
is target discovery: browser-use `get_all_frames()` enumerates all top-level
page targets when cross-origin iframe support is enabled. Rose treated that
inventory as the current page's frame tree, so a matching field on another tab
was eligible for mutation. The result retained only filled reference names,
and the handoff handler attributed them to the current URL. The deepest proven
gap is missing page ownership when admitting frame targets, not missing card
credentials or model capability.

The real-Chromium permanent test focuses a login page and exposes a separate
checkout with an actual cross-site OOPIF plus an unrelated payment tab. It uses
real CDP frame ownership and production fill JavaScript. Before the repair it
changed the background PAN field to a synthetic test number and returned
success. It also covers an orphan iframe whose parent is absent, and verifies
the legitimate focused checkout's OOPIF remains fillable via CDP afterward.

Initial identical reproduction command (from `agents/`):

```bash
/usr/bin/time -p venv/bin/python -c 'import asyncio, runpy, sys; sys.path.insert(0, "tests/blackbox"); asyncio.run(runpy.run_path("tests/blackbox/spawn_browser_agent_v3.blackbox.py")["test_payment_ref_fill_isolated_to_focused_page_and_child_frames"]())'
```

Pre-fix: exit 1, 1.87 seconds, `AssertionError: approved payment-card fill
changed the background checkout while the login tab was focused; background
value length=16, reported success=True`. Post-fix: exit 0, 2.82 seconds, both
background/orphan checks passed and the legitimate payment field filled. The
test was subsequently strengthened to require CDP for the positive case;
separate final-test baseline/current artifacts preserve that stronger proof.

The final unchanged test was also run with the original helper compiled from
`git show b784977b0bf699c56bc67b063ae849a9cf5150fb:agents/domains/spawn_browser_agent_v3/service_actions.py`, then
with the repaired helper, through the identical command
`cd agents && /usr/bin/time -p venv/bin/python ../.context/run-payment-fill-repro.py`.
The scratch runner replaces only `_iter_payment_fill_targets` with the selected
source snapshot and invokes the permanent test. Baseline: the same assertion,
exit 1, 1.94 seconds. Repair: exit 0, 2.07 seconds, with valid CDP filling.
Both runs record the same test SHA-256
`d0200d5b29c74280d208fa35bd9b6a12f246b13dc5eafbcf2ebed03d48a0f5c3`.
Thus the strengthened positive assertion was not substituted for causal proof.

Archive searches: `payment_card_ready secret refs card_number card_expiry
card_cvv`; `card credentials missing browser resume payment handoff`; and
`cookie bundle re-injection overwrites new login browser realm switch`.
Related cases are the October 2 shadow-index fill and October 3 empty-selector
resume cases. Neither diagnosed admission of unrelated top-level frame targets;
this is a relative, not a proven recurrence.

Golden reference: OpenClaw's
`extensions/browser/src/browser/pw-tools-core.interactions.actions.ts:252`
types through a locator on the selected target, while `:228` resolves native
insertion through `getPageForTargetId`. Hermes
`tools/browser_tool.py:1126` binds evaluation to a concrete tab ID. Searches of
Claude Code and Codex browser/iframe/fill references did not find an analogous
payment-frame subsystem. Restricting our CDP inventory converges on target
binding rather than merchant-specific filters.

Coverage/routing distinction: the canonical production env reader returned
`AGENTCARD_MINT_ENABLED = false`. Ordinary traffic therefore used the shared
company-funded Brex card, whose metadata cap is $50/week, for this $500 request.
Benchmark agents explicitly bypass the cutoff and exercise real AgentCard.
The production abandonment gate last passed October 13 at 23:02 UTC, but it
asserts readiness and financial compensation, not checkout field delivery.
Old CDP tests supplied a single frame without competing page ownership; the
handoff test inspected source strings. These coverage gaps cannot be repaired
by claiming the live lifecycle test proves all checkout handoffs.

Scope limits: this test proves the background CDP fill and false current-page
attribution mechanism. It does not prove why the first browser lost checkout
after a ten-hour approval wait, why a storage/login tab became current, or why
the later checkout lost authentication. Those are unresolved observations.
Changing providers would not fix target discovery. Caller-supplied Playwright
page binding and focus changes during an action remain separate contracts.

## Solution

Target discovery now builds parent-frame adjacency, starts at roots matching
`session.agent_focus_target_id`, and admits only reachable descendants before
opening CDP sessions. Unrelated roots and orphaned frames stay excluded.
Existing caller-bound Playwright filling and valid cross-origin descendants
are preserved. No prompt, trajectory injection, timeout, provider routing,
production setting or real card configuration was changed.

This unifies CDP discovery around one page-ownership invariant. Deleting CDP
iframe support would break legitimate hosted widgets; ownership cannot be
inferred from a matching merchant hostname or field name. The repair also
prevents unrelated payment-tab mutation and detached/orphan-frame admission.
At 10,000 agents it adds only per-session O(frames) adjacency and iterative
traversal, with no shared state or additional browser/database/network calls.

The existing `spawn-browser-agent-v3` blackbox domain discovers the registered
test. Its full official runner passed 690 cases in 55.53 seconds (exit 0).
Deploy Step 4g executes that runner under agent coverage for changes to this
production surface. Two old CDP fixtures gained realistic focused-root and
parent metadata without weakening their assertions. Independent adversarial
review passed the narrowly stated diagnosis and repair.

The narrow CDP ownership repair is implemented and reproduced above. Its
shipping gates and production rollout are tracked separately in this change's
deploy scorecard. This case stays open for the unresolved checkout and
authentication observations; the original purchase has not been replayed or
proven to complete. The static mint cutoff remains a documented production
configuration; changing it requires explicit approval.

## Human feedback

None recorded.

## Reusable lesson

Bind semantic secret-field discovery to the focused page's proven frame tree before interpreting a successful fill as current-page progress.
