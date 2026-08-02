---
id: 2026-07-28-network-capture-bodies-written-to-dev-only-file
date: 2026-07-28
title: read_network_requests wrote bodies to a dev-only file and refused NEW requests at capacity, so agents abandoned the tool
surface: agents
component: browser-agent
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: browser network recorder — response bodies persisted to a local-recording-only file instead of an in-memory budget
symptoms:
  - 'read_network_requests returns "capture is not active" on every call in prod'
  - agents conclude the tool cannot return bodies and stop calling it
  - every API call made after a heavy page load is missing from a newest-first tool
  - 'raw "read_network_requests..." chip rendered with a generic Info icon'
tags:
  - browser-agent
  - network-capture
  - cdp
  - tooling
  - eviction
sources:
  - PR #915
  - commit e6f2894a7
repro: none-recorded
status: fixed
---

## Problem

`read_network_requests` was effectively unusable. It captured only XHR/Fetch/
Document metadata, dropped headers and post data, wrote response bodies to a
dev-only file the agent could never read, and returned "capture is not active" on
every call in prod. Agents correctly concluded it could not return bodies and
stopped using it.

## Diagnosis

Three independent design faults converged on the same observable dead end. (1)
Bodies were only persisted when local recording was enabled, so in prod there was
nothing to read and the tool honestly reported an inactive capture. (2) The
capture filtered to a narrow resource-type set, so most of the page's traffic was
never recorded at all. (3) At capacity the buffer refused **new** requests instead
of evicting the oldest — which, for a newest-first reader, hides exactly the API
calls made after a heavy page load, i.e. the ones an agent wants. The
first-bad-boundary is the recorder's storage decision: it coupled body
availability to a developer-only artifact rather than to a bounded in-memory
budget.

## Solution

Capture metadata for EVERY http(s) request (DevTools parity), fetching bodies only
for text-ish payloads so images/fonts/JS cost nothing. Keep decoded bodies in
memory under a byte budget so reads work in prod. Capture request/response
headers, post data, redirect chains, timing and size. Evict OLDEST at capacity.
Add method/status/resource_type filters and opt-in detail flags
(`include_bodies`, `include_headers`, `include_query`, `max_body_chars`). Mask
only cookie/authorization, since agents replay authenticated calls via
`evaluate`+`fetch`. Growth is explicitly bounded for 10k agents: <=600 entries and
a 2MB body cache in prod, oldest-first.

Surrounding debt fixed in the same change: 16 browser action types had no icon and
fell through to a generic Info (plus a `BROWSER_EMITTED_ACTION_TYPES` contract
test so new actions can't ship iconless); `build_action_titles` fell through to a
raw `read_network_requests...` chip; `pydantic-settings` was missing from
requirements (browser_use imports it undeclared — 40+ blackbox tests failed
locally on `ModuleNotFoundError`); a positional-index flake in
`test_complete_browser_use_waterfall_only_path`; and the prompt-approval guard
never matched tool descriptions (a false negative on this very diff) — it now
matches `description=` assignments with 3 regression cases.

## Human feedback

Human approval was retrieved for the prompt-related hunks in this diff
(PROMPT-RNR-1) after the prompt-approval guard's own gap was fixed and cemented.

## Reusable lesson

If a tool's payload is only available under a dev-only flag, agents will learn it
is useless — keep tool output available in prod under a bounded in-memory budget
and evict oldest, never refuse newest.
