---
id: 2026-09-28-foundry-precontent-error-escaped-waterfall
date: 2026-09-28
title: A pre-content Foundry error escaped the agent waterfall
surface: agents
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/client.py RoseClient._complete_impl Foundry exception handler
symptoms:
  - "Foundry deployment gpt-6-sol returned 500"
  - "rose.complete.failed active_route=foundry"
  - "client_foundry_server_error_falls_through_to_openrouter"
tags:
  - foundry
  - rose-client
  - waterfall
  - pre-content-error
sources:
  - commit a58f662a6244609b14b09435254f8d653b09ed2d
repro: agents/tests/blackbox/rose.blackbox.py
status: fixed
---

## Problem

While adding the Foundry fallback, the agent coverage run sent an Ultra request
through a mocked Foundry 500. The request terminated with `RoseServerError:
Foundry deployment gpt-6-sol returned 500` before producing a chunk. Three
existing waterfall cases failed, and the new
`client_foundry_server_error_falls_through_to_openrouter` blackbox failed with
the same error. The new test runs the real Rose client and captures both
provider HTTP boundaries.

## Diagnosis

Archive searches for the literal Foundry 500 and for a pre-content provider
error missing the OpenRouter fallthrough found no prior case at this boundary.
The path was Foundry HTTP 500 → `foundry_complete` raises `RoseServerError` →
`RoseClient._complete_impl` handles only `_FallThrough` and `RoseStallError` →
the outer error logger and caller see a terminal failure. The first bad
boundary was the Foundry branch's narrower exception handler. Other routes
wrap their provider error in `_FallThrough`, but this new route yielded the
provider exception directly. The contract is that any pre-content Rose error
can continue to the next configured route.

Before the fix, `venv/bin/python scripts/run_blackbox_tests.py rose` recorded
`❌ client_foundry_server_error_falls_through_to_openrouter: Foundry deployment
gpt-6-sol returned 500`. The unchanged command then recorded `✅
client_foundry_server_error_falls_through_to_openrouter` and `Results: 1
passed, 0 failed` after the fix.

## Solution

The Foundry branch now catches `RoseError` along with the existing fallthrough
and stall types when nothing has been yielded. It still raises errors after
visible output, so a partial tool call cannot be spliced into another provider
stream. The blackbox asserts Foundry 500 → OpenRouter content and ordering.
For 10,000 concurrent agents, each request follows its own route without a
new shared queue or per-agent retained state.

## Human feedback

None recorded.

## Reusable lesson

Cover every new provider branch with a full-client pre-content error test so its exception type cannot bypass the waterfall contract.
