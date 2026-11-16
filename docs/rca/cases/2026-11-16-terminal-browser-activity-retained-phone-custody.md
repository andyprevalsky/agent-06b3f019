---
id: 2026-11-16-terminal-browser-activity-retained-phone-custody
date: 2026-11-16
title: Terminal browser activity retained its phone lease while the parent remained active
surface: agents
component: spawn-browser-agent-v3 / terminal phone custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _schedule_browser_cleanup released browser resources but never the activity-owned phone lease
symptoms:
  - Max iterations (250) reached
  - User messages sent to this browser after its last step (it did not act on them)
  - Terminal browser cleanup left its recorded phone lease held
tags:
  - phone
  - browser
  - cleanup
  - lease
sources:
  - agent 20440423-026a-584f-aed1-dbd59d6dc693
  - memory: browser task 91a0ff73-a8e8-5c2f-8444-04f2262a0725
  - commit 16e079f926f8e69c716c20070561d3ed23344d5e
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_terminal_browser_cleanup_releases_only_recorded_phone_custody
status: open
---

## Problem

The native phone browser task exhausted its 250-step budget at 06:08 on
2026-11-16 after the completion verifier rejected its completed configuration.
The parent agent and shared logical browser session remained alive. A second
phone lease, acquired at 06:03:28.647Z after the first lease was released at
05:57:51.379Z, remained held until a separate release-only browser task released
it at 06:10:12.077Z. The stopped browser could not execute the release-only
instruction received after its final step. This investigation performed no
live phone operation; original lease timing was read in a READ ONLY transaction.

## Diagnosis

The causal path is successful backend acquire/observation -> activity-local
phone execution -> cap exit -> browser/CDP cleanup -> parent continues. The
cleanup owner tracked browser resources but not the independently leased phone.
Backend reconcileActive checks the parent agent and existence of the shared
BrowserSession. Neither becomes terminal when one child activity exhausts its
budget, so that reconciliation cannot represent this activity's terminality.
The one logical browser row was ultimately CLOSED at 06:13:25.808Z; marking all
paused browser rows terminal would also destroy legitimate resume custody.

Archive searches: `browser capped phone lease release` and
`configurationReady operationalStatus unknown verifier`. Actual ownership
reads covered the b82/RCA98 canonical-evidence repair, setup OCR verifier,
Gmail unknown, borrower handback and 30-minute checkpoint RCAs. Those are
relatives, not the same boundary. The October 18 idle-session cleanup case
begins after a lease is released, whereas this defect omitted that release.
The 30-minute repair deliberately retained the whole-task 250-step budget.
The b82/RCA98 fix did not omit this incident's successful setup evidence.

The normal runner failed on original source with the unweakened assertion
`Terminal browser cleanup left its recorded phone lease held`. The unchanged
command passed with the repair. The expanded existing max-step fixture executes
the real activity epilogue with a restored exact lease and asserts one release
while preserving the failed max_iterations result and partial structured output.
A provider pause for persistence is not a resumable activity pause; the cap does
not set paused_session_id. Explicit resumable and sealed paths remain excluded.

## Solution

Candidate only; parent owns review and deployment. Existing BrowserCleanupOwners
retains exact backend-returned lease IDs for this user/task, including an acquire
whose following command fails. Existing encrypted resume continuity carries
these IDs and restores only matching user/task bindings. Confirmed explicit
release removes its ID. Terminal activity cleanup releases retained IDs through
the existing ownership-checked backend lease release route. It never discovers,
acquires, resets or sends a phone command to locate cleanup targets.

Resumable authentication, checkpoint and local-only generation cleanup preserve
custody. Foreign task observations never enter this task's cleanup set. An
unconfirmed response retains the ID and logs the exception type. A separate
phone receipt records confirmed/unconfirmed lease release and complete/pending/
not_reported provider cleanup without changing the browser task outcome. The
manager carries this factual receipt into parent-visible tool text for returned
results, including cancellation. Generic raised exceptions still carry the
receipt only on the FE terminal row; their original exception is preserved.
New active custody invalidates earlier release receipts before a resumable
pause. Browser
recording/CDP cleanup still runs. Repeating cleanup after confirmed release
performs no additional request. Backend in-flight-operation fences remain
unchanged: requesting release is not a claim of physical cleanup completion.

Owning focused command (from agents with venv active):
`BLACKBOX_CASE_FUNCTIONS=test_terminal_browser_cleanup_releases_only_recorded_phone_custody python scripts/run_blackbox_tests.py spawn-browser-agent-v3`.
Original source: exit 1. Candidate: exit 0. Additional negative controls and
actual-cap checks run in the same normal suite. Test-map lane:
`agents-blackbox spawn-browser-agent-v3`. Integrated commit 093f1bb88b5f passed all eleven focused controls five times
(11.0, 11.2, 9.9, 9.3, 10.8 seconds). The full owning suite and independent
review are pending; no production outcome is claimed.

Golden analogs inspected: OpenClaw
`src/agents/session-placement-forced-terminal-settlement.ts:4` carries an exact
turn's cleanup through async ownership and explicitly clears inherited claims;
Codex `codex-rs/core/src/session/startup.rs:65` owns shutdown and records failures;
Hermes `tools/browser_tool_lifecycle.py:618` and `:697` release only the exact
owned task session. This repair follows that ownership pattern rather than
scanning global browser/phone state. At 10,000 agents it adds bounded local
lease bookkeeping and one existing release request per retained lease, no
fleet scan or polling process.

## Human feedback

The user prohibited all live phone operations, including cleanup/release tests,
and required logs, read-only database evidence and synthetic offline tests only.
The parent required exact task ownership, preservation of resumable pauses and
sealed-generation no-write behavior, actual-cap coverage and independent review.
No Freedom or protected instruction files were changed.

## Reusable lesson

Retain every independently acquired resource in the exact activity's cleanup
ownership, and distinguish terminal activity completion from a reusable parent
or session remaining alive.
