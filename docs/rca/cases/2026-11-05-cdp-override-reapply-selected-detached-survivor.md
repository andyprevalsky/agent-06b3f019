---
id: 2026-11-05-cdp-override-reapply-selected-detached-survivor
date: 2026-11-05
title: CDP override restoration abandoned a live target after choosing a stale session locator
surface: agents
component: cdp-multiplexer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _reapply_overrides_after_detach selected only the first cached same-target session even when Chrome confirmed it was gone
symptoms:
  - "Session with given id not found."
  - "holder for target"
  - "detached and re-apply on"
tags:
  - tilion
  - cdp
  - multiplexer
  - locale
  - timezone
  - detach
sources:
  - agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb
  - commit 67998442e44f8cbba942040d9cbeeaea84eb0cb0
  - PR #1697
  - PR #1697 review comment 4487737333
  - PR #1866 (shipped; merge 7577a6573682179b3715fa25e9433e27cf9e24e6)
repro: agents/tests/blackbox/browser_tilion.blackbox.py
status: open
---

## Problem

Root worker logs at 2026-11-03T04:00:15.689Z, 04:00:42.180Z and 04:00:48.660Z report timezone reapplication returning CDP -32001, `Session with given id not found.` Child f5ec0b6b logs show the same failure for both timezone and locale on November 5. These errors are distinct from response-body capture warnings and an individual stale DOM index.

## Diagnosis

Path: native target-session detach -> mux override owner removed -> first cached same-target survivor chosen -> Chrome returns -32001 -> no next same-target session considered. Native detach can precede delivery/processing of its event, so the map can contain a dead locator. The old implementation abandons the target despite a valid survivor.

Captured-response replay uses the exact observed CDP error through the production reapply method, with one gone and one live same-target session. Assertion: both overrides must be owned by the live survivor and the confirmed-dead locator removed. From agents:

```sh
venv/bin/python - <<'PYCODE'
import asyncio, importlib.util,sys
sys.path.insert(0,'tests/blackbox')
spec=importlib.util.spec_from_file_location('browser_tilion','tests/blackbox/browser_tilion.blackbox.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
asyncio.run(m.test_multiplexer_reapplies_past_a_confirmed_detached_survivor())
PYCODE
```

The unchanged command failed before and passed after; baseline failure selected gone twice and left the live target without owners. Evidence: `.context/rca-7a2ead9f/mux-before.txt` / `mux-after.txt`. This proves the restoration boundary, not that every historical logged target had a survivor or that a site task succeeded.

Archive searches: `CdpMux detached re-apply Session with given id not found` and a literal archive search for `Session with given id not found` / `re-apply on`. Relative of the Tilion multiplexer and slow-DOM cases, not proof of those causes recurring.

## Solution

Try the finite set of sessions already bound to the same target. Remove and skip a locator only after Chrome's specific -32001 missing-session response; retain error reporting and stop on other failures. Verify a candidate still belongs to the target before claiming successful restoration. No new provider connection, cross-target reuse, synthetic model messages or changed timeout. Work is bounded by the existing attached sessions, independent of total agent population.

Golden reference: not applicable (CDP transport adapter, no approval-gated hunk). Registered in the existing browser-tilion blackbox suite and selected agent deploy coverage. Local replay fail/pass is proven; full suite, independent review and deployment remain pending at initial case creation. No model-intelligence claim is made.
### November 6 review regression

CodeRabbit review 5794138610 identified a split-holder case in the candidate: the dead survivor may itself hold locale while a different departing session holds timezone. Removing the dead locator directly discarded the target identity needed to restore its separately owned locale. A new permanent blackbox `test_multiplexer_retires_all_overrides_of_a_dead_survivor` failed before the correction (timezone restored, locale still owned by gone) and passed unchanged afterward. Evidence: `.context/rca-7a2ead9f/mux-split-permanent-before.txt` and `mux-split-permanent-after.txt`. The confirmed-dead path now uses the existing detach owner to retire and reassign every override before removing the locator. The new test joins all spawned restoration work before asserting both live owners. This is a candidate-review correction, not a claim of a shipped recurrence.


Third review4489734409 identified an observability gap when every same-target candidate is positively confirmed dead: the retry loop exhausted silently. It now reports the lost override only after encountering a confirmed-dead locator and only while no concurrent task has restored its holder. An empty survivor list after ordinary target closure does not log a failure. The permanent registered blackbox covers exhausted-dead, concurrently restored and normally closed cases; the owning log assertion fails before, all three plus the existing live-survivor/split-holder controls pass after. Private evidence: cdp-reporting-before.log / cdp-reporting-after.log. No timeout, session selection or provider allocation rule changes.

## Human feedback

The user requested `/rca` for agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb and asked to fix all its browser issues. No subsequent corrections recorded.

## Reusable lesson

Retire a confirmed-dead CDP locator and restore target-scoped state on an existing same-target survivor instead of abandoning the target after the first cached locator fails.
