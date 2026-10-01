---
id: 2026-09-28-external-heading-drift-invalidated-browser-smoke
date: 2026-09-28
title: External page removed the heading required by browser-smoke
surface: harness
component: agents/benchmarks/browser-smoke
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "agents/benchmarks/tasks.json browser-smoke prompt required an H1 on https://example.com without owning or pinning that page"
symptoms:
  - browser-smoke target https://example.com has no H1; body bytes=713
  - browser-smoke attempt_completion rejected after evaluate found no H1
  - browser-smoke times out although example.com returned HTTP 200
tags:
  - browser-smoke
  - external-fixture-drift
  - heading
sources:
  - agent d3dbf69f-b718-438a-8eea-0497d5898c69
  - agent d26f50df-874c-41ca-ad04-2300c73eaa60
  - agent 22a355af-700d-4f57-a2a0-2723952f3bc9
  - agent 412c1cd2-cfa1-4bf3-bac4-0e150ff97bba
repro: none-recorded
status: fixed
---

## Problem

The original `browser-smoke` asked a browser agent for the main heading on
`https://example.com`. The site returned HTTP 200 and a 713-byte body with no
H1. The agent's `evaluate` action found no heading, and four truthful
`attempt_completion` calls were rejected. A local fetch-based repro returned
`browser-smoke target https://example.com has no H1; body bytes=713`.

## Diagnosis

The first bad boundary was the benchmark catalog's live URL and H1 expectation.
It treated an external page as a stable test fixture. The browser verifier was
correct to reject the document title as an H1. This is fixture drift in the
test, not a failure of Foundry routing or heading extraction. The next-deeper
option of teaching the agent to infer an H1 from a title would violate the
page-grounded browser contract. The user changed the smoke goal to reporting
the main color palette of `roselabs.ai`, so the old H1 assertion is no longer
the intended behavior.

## Solution

The approved catalog change visits `https://www.roselabs.ai`, asks for at least
three prominent colors, and adds a semantic evaluator that checks the browser
visit and root palette answer. Its timeout floor and ceiling account for live
browser recording and verifier time. The exact palette-only task passed locally
with Steel in 174.6 seconds, with a finished recording and a 100% repeatable
cache hit. It adds no calls to normal user agents; 10,000 benchmark runs would
each add one browser visit. The user approved the LLM-visible benchmark diff.

The default Kernel run exposed a separate provider issue: managed-proxy creation
stalled until the 180-second session-init read timeout; a later browser attempt
reached the site, but the benchmark failed because the first child had zero
browser steps. Isolated benchmark database restores had lost the local proxy
row while the Kernel project still had matching available proxies. Session
initialization now reuses a matching project proxy before creating one. The
default-provider palette task then passed twice; the final run took 203 seconds,
recorded browser steps and a finished recording, and reported three Foundry
calls at $0.00 user cost. Its durable FE is
`https://www.roselabs.ai/?agent-id=412c1cd2-cfa1-4bf3-bac4-0e150ff97bba`.

## Human feedback

The user rejected unrelated planner changes, directed the smoke task to
`roselabs.ai` instead of a checked-in heading page, and asked for a palette
answer verified as a palette. They also asked for a diagnosis of the other
failing gates rather than changing their goals.

## Reusable lesson

Use a site and assertion owned by the benchmark goal, and verify live page
evidence before blaming the agent when an external page changes.
