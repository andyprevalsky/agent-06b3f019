---
id: 2026-10-01-clean-document-skipped-failed-api-route
date: 2026-10-01
title: A clean browser document suppressed recovery from a failed first-party API route
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py recover_from_challenge clean-page gate called live_tab_looks_challenged without the captured network failure or recovery reason
symptoms:
  - "net::ERR_TUNNEL_CONNECTION_FAILED"
  - "Current page does not look challenged"
  - "Failed to fetch"
  - "Timeout after 904s (dynamic cap=900s)"
tags:
  - browser-agent
  - network-recovery
  - first-party-api
  - agentcard
sources:
  - agent 9abd3981-2c98-4072-819a-ab66f57b1c2a
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

The unchanged local `agent-payment-idempotent-abandonment` benchmark timed out after 904 seconds. Its first browser task prepared the checkout and one-time card. In the second task, the browser's POST to `/api/test-payment/confirm` failed three times with `net::ERR_TUNNEL_CONNECTION_FAILED`, while the rendered checkout remained visible. The first `recover_from_challenge` request returned `Current page does not look challenged` and left the same browser route in place. A later attempt selected `steel_fixed`; that session reached the same checkout URL and the backend logged POST `/api/test-payment/confirm` 200 at 07:00:54, after the benchmark's time budget was spent. The run-scoped cloudflared log showed no runtime disconnection; it remained registered until teardown. The sibling payment tasks passed on the same public tunnel before this failure.

## Diagnosis

The failing Kernel session's network recording has terminal POST rows with no HTTP status and `net::ERR_TUNNEL_CONNECTION_FAILED`; the backend saw none of those POSTs, then received the Steel session's POST several minutes later. This proves a browser transport failure and a later working route. It does not isolate whether the earlier failure was specific to Kernel or temporary tunnel availability. The first bad owned boundary was the clean-page gate in `handler.py`: it asked `live_tab_looks_challenged(input_page)` whether the current document looked challenged but omitted the recovery reason and the existing network recorder. The visible checkout DOM was clean, so the gate discarded an explicit recovery request for a failed first-party API URL. The later navigation failure made the document itself look broken and allowed recovery, at the cost of more than two minutes.

The critical path was checkout submit → browser network recorder → `recover_from_challenge` request → clean-page gate → recovery skip message → repeated browser actions → benchmark timeout. The network recorder held the failure; the gate lost it. Archive searches for `net::ERR_TUNNEL_CONNECTION_FAILED recover_from_challenge clean document` and `browser agent checkout page visible failed API request recovery skipped` found a related case, `2026-08-19-stripe-checkout-llm-leaves-for-api-host`, which introduced the clean-page skip to prevent noisy repeat recovery. This is a related contract gap, not a recurrence of that case's navigation failure. Its human feedback rejected endpoint-specific payment logic; this fix uses cited first-party request evidence without merchant or path names.

The permanent blackbox `test_live_tab_recovery_keeps_failed_cited_request` reproduces the boundary with a clean document, a cited POST, and the captured transport error shape. It also asserts the handler passes the existing recorder and recovery reason to the helper. Before the fix, `PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python -c "import asyncio,runpy; d=runpy.run_path('agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py'); asyncio.run(d['test_live_tab_recovery_keeps_failed_cited_request']())"` exited 1 with `AssertionError` because the gate returned false. With only the old handler restored, the strengthened unchanged test again exited 1 in 1.31s because the handler omitted both inputs; on the fixed handler it exited 0 in 0.44s.

The four-task deploy gate failed on the buggy tree in run `20261001_070625_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json` (900s cap for the idempotent task; agent `9abd3981-2c98-4072-819a-ab66f57b1c2a`). The unchanged idempotent task passed as a single-task run on the fixed tree in `20261001_072243_agent-payment-idempotent-abandonment.json` (315.2s, 9.0c, agent `a2bff0df-3c51-489a-a741-886a2e85fc18`). A same-command single-task run on the buggy tree also passed in `20261001_073214_agent-payment-idempotent-abandonment.json` (372.2s, 12.0c, agent `6c2a963b-e71c-45bd-adc6-fc9e41eff58d`): its checkout POST reached the backend with HTTP 200, so that run did not reproduce the network failure. The full four-task local gate passed on the fixed tree in `20261001_204219_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json` (4/4, 22.0c). No task prompt, evaluator, fixture, or timeout was changed. Durable FE links for the failed gate and passing four-task idempotent run: `https://www.roselabs.ai/?agent-id=9abd3981-2c98-4072-819a-ab66f57b1c2a` and `https://www.roselabs.ai/?agent-id=b43291dd-7f9c-4ab6-b7ba-397ae0bd5f47`.

## Solution

The clean-page gate now passes the existing recovery reason and network recorder. `live_tab_looks_challenged` permits recovery when the newest completed row for a cited first-party method and URL still shows a tunnel or proxy connection failure, even if the document remains visible. An in-flight retry leaves the failure unresolved; a newer success for the same method and URL clears it. The recorder filters to each cited URL before its 100-row limit, so unrelated background requests cannot crowd out the failure. This uses captured network facts and adds no LLM-visible text. It also covers sibling checkout and form-submit routes that fail behind a healthy cached page. The recorder scans its bounded buffer per cited URL, with no shared work as agent count grows to 10,000. The worker must restart before the benchmark can exercise the fix.

## Human feedback

The user requested `/rca`, proof that the AgentCard task passes, and approval of changes before deploy. No feedback on this browser recovery fix was recorded.

## Reusable lesson

Check failed first-party requests cited by a recovery action before treating a visible document as proof that the browser route is healthy.
