---
id: 2026-09-28-obsolete-browser-use-navigation-timeout-patch
date: 2026-09-28
title: An obsolete browser-use navigation patch still replaced asyncio.wait_for
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py start-url navigation setup
symptoms:
  - "browser-use no longer hardcodes nav_timeout=20.0"
  - "browser_use_upstream_still_hardcodes_page_navigate_20s"
  - "browser_navigation_uses_event_timeout_without_global_patch"
tags:
  - browser-use
  - navigation-timeout
  - obsolete-patch
sources:
  - commit a58f662a6244609b14b09435254f8d653b09ed2d
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

Agent coverage failed the browser-use upstream canary: the installed
`BrowserSession._navigate_and_wait` no longer contains its former
`nav_timeout = 20.0` wait. Our start-url path still installed a wrapper that
temporarily replaced the process-wide `asyncio.wait_for` to rewrite every
20-second wait inside that method. The canary reported the upstream change,
and a new blackbox asserted the configured event timeout and absence of the
global patch; it failed on the old handler.

## Diagnosis

Archive searches for the exact canary error and for an obsolete navigation
patch found no prior case at this boundary. The installed browser-use version
uses `NavigateToUrlEvent.event_timeout`, which read the configured 300-second
`TIMEOUT_NavigateToUrlEvent` value in the local reproduction. Its current
navigation method calls `Page.navigate` without the 20-second `wait_for` the
patch was designed to replace. The first bad boundary was the handler still
applying a process-global workaround after the dependency contract changed.

## Solution

The handler no longer imports or applies the patch, and the obsolete patch
module and old hardcode-specific tests were removed. The permanent blackbox
now checks the installed upstream method, the actual event timeout, and the
handler's lack of a global wait replacement. Before the change,
`venv/bin/python scripts/run_blackbox_tests.py spawn-browser-agent-v3`
reported that case failing; the unchanged command passed the new case and the
whole domain after the change. At 10,000 agents this removes a process-wide
mutation that could have overlapped unrelated navigation tasks.

## Human feedback

None recorded.

## Reusable lesson

Remove a dependency workaround as soon as an upstream canary proves the original behavior has changed, and replace the canary with a positive contract test.
