---
id: 2026-08-22-read-logs-console-network-status-enrichment
date: 2026-08-22
title: read_network_requests missed Hotels.com 429 because CDP responses lacked status and console was separate
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/recording.py::BrowserNetworkRecorder.start — Network.enable on unfocused CDP session; query_requests status filter blind to console-only 429 evidence
symptoms:
  - 'Captured 0 network request(s) with status=error'
  - 'ApolloError: Response not successful: Received status code 429'
  - 'lodgingPropertyCheckoutPrepareCheckout with status null'
  - read_network_requests
  - browser-hotel-booking Reserve stall max steps
tags:
  - browser-agent
  - read-logs
  - read-network-requests
  - hotels-com
  - graphql-429
  - console-correlation
sources:
  - agent aba4c297-090f-40d1-816b-f0b69c107b32
repro: cd agents && python scripts/run_blackbox_tests.py browser-read-logs
status: fixed
---

## Problem

`browser-hotel-booking` agent `aba4c297` clicked Reserve 14× but never reached
checkout. Console capture showed **198×** `ApolloError … status code 429` on the
Hotel Kabuki property page, while `read_network_requests` returned either **0 rows**
(`status=error` on an empty buffer) or **5 telemetry rows** after `clear=true` —
all with `status: null`. The persisted network index had **600 request rows, 0
with HTTP status**.

## Diagnosis

Archive searches: `read_network_requests status null`, `network summary omits HTTP
status graphql 429` — relative of
`2026-08-21-hotels-com-classifier-network-summary-omits-http-status` (classifier
path fixed earlier; live recorder path still blind).

Three stacked gaps:

1. **CDP attach** — `BrowserNetworkRecorder.start()` called
   `get_or_create_cdp_session()` without `focus=True`, so Kernel sessions captured
   `requestWillBeSent` but not `responseReceived` metadata.
2. **Split buffers** — console 429 evidence lived in a separate buffer with
   no tool to query it; `read_network_requests` could not see Apollo errors.
3. **Agent query** — `status=error` filter matches only numeric `status >= 400`;
   `null` rows never match even when GraphQL was failing.

## Solution

- Added **`read_logs`** tool: merged console + network rows, regex `pattern`
  filter, optional per-source filters. Replaces `read_network_requests` in the
  active tool catalog (`read_network_requests` handler kept for backward compat).
- **CDP fix**: `Network.enable` on `focus=True` session; disable prior session on
  re-attach after `transition_browser`.
- **Console→network enrichment**: parse `Failed to load resource … status of N` and
  `ApolloError … status code N`; backfill `status` on matching network rows
  (`status_source=console`).
- **Tests**: production diagnostic fixtures from `aba4c297` (
  `agents/tests/fixtures/browser_diagnostics/aba4c297_hotel_kabuki_429/`) —
  `browser-read-logs` blackbox domain.

Local repro (pre-fix would fail `read_logs_enriches_graphql_status`; post-fix PASS):

```bash
cd agents && python scripts/run_blackbox_tests.py browser-read-logs
```

## Human feedback

User requested `read_logs` combining console + network with regex support, robust
tests on real production captures (not fabricated), then rerun
`browser-hotel-booking` benchmark.

## Follow-up (2026-08-22 benchmark)

Post-fix `browser-hotel-booking` (agent `343eaf0a`, run
`20260822_195257_browser-hotel-booking.json`) **failed the guest-checkout
evaluator** but **proved `read_logs`**: network `status=4xx` returned 20 GraphQL
429 rows. Agent reached payment approval ($343.61). Failure is orthogonal —
challenge recovery preserved signed-in cookies (recurrence of
`2026-08-21-hotels-com-diagnostic-clean-strip-discarded-for-auth`).

## Reusable lesson

When CDP Network metadata lacks response status, expose console and network through
one regex-queryable `read_logs` tool and backfill HTTP status from console error
lines before the agent concludes nothing failed.
