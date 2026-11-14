---
id: 2026-10-31-r131-browser-deadline-and-later-archive-disk-failure
date: 2026-10-31
title: BU091 research reached its activity deadline before a separate archive disk failure
surface: agents
component: browser-activity-duration-and-original-custody
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Browser activity remained incomplete at its configured 50-minute StartToClose deadline; deepest research and late CDP-wait cause is unproved
symptoms:
  - Browser manager failed activity StartToClose timeout
  - Last saved browser step 85/100 before native FAILED
  - Later shared-relay archive copy failed with ENOSPC
tags:
  - r131
  - polar-bu-091
  - activity-timeout
  - archive-custody
sources:
  - commit 691b9059a9ca3b41552be9679d712b50edcf24d5
  - agent dbfd63f8-a098-4fd5-b63c-50e8f7ca401d
repro: Hash-bound original timing and source timeout calculation only; no causal repair or model replay
status: open
---

## Problem

It30 BU091r1 ended nativeFAILED/progress0 after3033.6seconds. Archive
`7fbc7f699c8ad5549f6e97d58e22586d2ed2427996f709c3c542fad78fd16404`
and all seven normal member hashes verify. Original benchmark failure and
producer infrastructure classification remain unchanged.

## Diagnosis

Activityb900be84-ab47-4455-b5bf-441d4320a51e began21:53:33.175753;
worker26684 reports StartToClose timeout22:43:34.619130, then cancellation
at26689 and an ERROR tool handoff. Exact691b timeout policy maps the100step
override to50minutes. The observed expiry follows that bound, not demonstrated
timer drift. Last saved budget count is85/100;150raw actions include uncharged
observations. A read_browser_state succeeded22:42:39 and the actor continued
searching alternate raid hypotheses, then issued another Bing navigation.
No completed answer or final verifier verdict was found.

CDP1006 at21:56:38 recovered after4.7seconds. Near expiry, target commands
waited with a recent reply12.1seconds earlier, and a browser-level attach was
later pending31seconds. Those are actual waits, not proof of an unrecovered
50minute transport outage or its initiating cause. All85 available application
dumps hash-verify; later requests, including step85, were skipped as
payload_too_large. Saved actions survive, but late raw-request parity is missing.
Initial schema is generic gunner_first_name/gunner_last_name with no answer
injection. Progress0 does not mean no research occurred.

A later host ENOSPC occurs copying shared-relay ownership files into the campaign
archive. No ENOSPC event was found in the parsed guest worker/backend events;
that does not assert every filesystem state was healthy. The guest timeout and
later controller archive failure must remain separate. Root's automatic stop,
unfinalized summary and release verification are independent custody facts,
not proof that the disk error caused this native failure.

## Solution

OPEN: no causal runtime repair demonstrated. The configured deadline worked;
there is no evidence justifying a timeout increase, retry, task change or vendor
blame. A correction needs a specific owned latency/data defect or controlled
original-request comparison. Two archive searches and long-research/timer
comparators were read; the local index was older than691b. No model/provider/
native call, source application, grade change or resource operation was made
by this investigator. Release status must come from the canonical owner proof.

## Human feedback

The user requires native/progress0 failures to receive priority while preserving
all original grades and resources. This does not authorize conflating later
archive failures with the guest cause or relaxing task and timeout limits.

## Reusable lesson

An enforced activity deadline proves where execution stopped, not why research
remained incomplete. Keep native timing, late transport waits and post-run
artifact failures distinct, and disclose missing late-request evidence.
