---
id: 2026-11-07-foundry-fallthrough-fixture-counted-cooldown-query
date: 2026-11-07
title: Foundry fallback fixture counted a shared-cooldown query as a provider attempt
surface: agents
component: rose-blackbox-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: test_client_foundry_server_error_falls_through_to_openrouter matches the Azure hostname anywhere in the request URL, including the cooldown query
tags:
  - foundry
  - blackbox
  - fixture-isolation
  - cooldown
symptoms:
  - assert attempted == ['foundry', 'openrouter']
  - rose.foundry.shared_cooldown_read_failed error_type=RoseServerError
  - rose FAIL (294 passed, 1 failed)
sources:
  - PR #1708
  - commit 60ca0ff528360e8e54198cec54c00a11fab4a50e
  - commit b365bf8bd69346f872e5e2cb7218872155ca294d
  - commit 0d3a03ae0da476027bfceaf35724c75744062119
repro: agents/tests/blackbox/rose.blackbox.py::test_client_foundry_server_error_fixture_isolates_authority_state
status: open
---

## Problem

The existing native agents-coverage Rose domain reported 294 passes and one failure. At 19:36:35 UTC its original test_client_foundry_server_error_falls_through_to_openrouter failed line 7750, after logs showed a failed shared cooldown read, one Foundry HTTP 500 and successful OpenRouter completion. The complete original log is preserved unchanged as original-native.log. The outer agents coverage gate remains the parent's work; no result here waives that original failure.

## Diagnosis

Gate: NOT_INTRODUCED. The original test has the same AST at 60ca, direct main b365 and original 0d3. Each revision was materialized with its own actual source closure, then ran the unchanged test through the same local capture harness and mocked request path. All three fail with attempted=['foundry', 'foundry', 'openrouter'] under the reconstructed warm state. The 124 loaded local modules at 60ca and b365, and 122 at 0d3, all match their corresponding Git revision; no mixed-version dependency substitution was used. closure-comparison.json retains the verification and request sequences.

Critical path: enclosing test environment provides BACKEND_API_KEY -> foundry._refresh_shared_cooldowns GETs the backend with the Azure deployment hostname in its keys query -> the test's substring matcher treats that GET as the Foundry data-plane attempt and returns its intentional provider HTTP 500 -> a sufficiently recent shared snapshot permits normal routing -> the actual Azure POST produces another counted Foundry 500 -> OpenRouter POST succeeds -> the unchanged two-route assertion sees three entries.

The first bad operation belongs to the test handler, not the production router: it matches the complete URL, including query parameters, instead of the destination host. The test also leaves shared-authority participation to its caller's environment, despite being a provider-only failure fixture. Its sibling provider-only fixtures already explicitly set BACKEND_API_KEY empty.

The isolated cold-state control revealed a false green: the GET is counted as Foundry, the unavailable authority prevents any Azure POST, OpenRouter succeeds, and the original assertion passes. The corrected reproduction first obtains a healthy empty cooldown snapshot through the real shared reader using an exact mocked authority response, then ages the snapshot by the existing five-second recheck interval plus one second. This is within the unchanged 30-second stale grace. The native log's failed read followed by an actual Azure request proves that branch; the original in-memory timestamp was not captured, so six seconds is a deterministic representative of its proven interval, not a claimed historical measurement.

What: the route-count test fails or falsely passes depending on cache state. Where: the existing test's handler and environment. Why: control-plane traffic is counted as data-plane traffic and the fixture inherits an unrelated authority. Proof: the actual unchanged test fails with the native three-request sequence before the fix and passes with exactly Azure POST 500 then OpenRouter POST 200 afterward. Problem: fixture/environment/data mismatch.

Archive queries were `test_client_foundry_server_error_falls_through_to_openrouter attempted` and `Foundry shared cooldown mock unexpected control plane request`. Read the solutions and human feedback in 2026-10-20-foundry-deployment-cooldown-per-process and 2026-10-02-stack-funded-key-cooldown-leaked-into-coverage-db. These are related shared-state context, not recurrences of the same test matcher defect. Production shared cooldowns remain required. No live model replay or agent bug-report query applies to this mocked Python test.

## Solution

Private proposal only, in rose.blackbox.py: match req.url.host exactly for the two provider routes and explicitly set BACKEND_API_KEY empty in this provider-only fixture. The three original assertions, request messages, models, output, budgets and timeout values are unchanged. There is no default successful authority response and no production fallback change.

The new permanent test invokes the original test under absent, fresh and stale-but-within-grace shared snapshots with a configured outer authority. It observes the actual mock transport and requires precisely POST Azure /openai/v1/responses with status 500 followed by POST OpenRouter /api/v1/chat/completions with status 200. It failed on the cold-state false green before the fix and passes afterward. It is registered in the existing Rose blackbox run_all_tests; no gate selection or coverage threshold changes.

The exact local command and cwd are identical for the same-cwd-before and same-cwd-after records in result.json. The original test fails before and passes afterward. The owning new regression passes five consecutive unchanged runs. Six existing/new targeted Rose tests pass, including the original fallthrough test, its fixture regression, regional 429 failover, optional-region handling, shared cooldown ladder and shared-state interleavings. These are focused native blackbox results, not a claim that the full 295-test domain or enclosing coverage gate passed.

This ordinary test-only change has no approval-gated runtime hunk; golden reference is not applicable. At 10,000 agents there is no production CPU, network, database, lock or memory effect. Parent review, routing and eventual integration remain outstanding, so the case remains open rather than claiming a deployed fix.

## Human feedback

The user directed the existing deploy to continue relentlessly and required the original clock, failures, selected tests and capacity limits to remain intact. The parent required private proposals while the original healthy workers ran; that coordination constraint was not a new human approval request. Assertions and budgets must not be weakened. Freedom and its protected instructions remain untouched.

## Reusable lesson

Make provider-only fixtures opt out of unrelated control-plane state and classify mocked requests by exact destinations, while asserting that the intended data-plane request actually occurred.
