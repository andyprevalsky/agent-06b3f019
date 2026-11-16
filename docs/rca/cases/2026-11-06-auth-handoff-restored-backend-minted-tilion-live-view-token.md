---
id: 2026-11-06-auth-handoff-restored-backend-minted-tilion-live-view-token
date: 2026-11-06
title: Auth-assistance activity result restored the backend-minted Tilion live-view token, so requestUserAuthentication.liveViewUrl persisted it unredacted
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py _visible_activity_result restored auth_assistance_request.handoff.liveViewUrl verbatim as an "exact protocol value" without the redact_url_secrets policy that browser_url already used
symptoms:
  - requestUserAuthentication.liveViewUrl carries live-view?token=<raw>&interactive=true&showControls=true while browserUrl carries live-view?token=REDACTED
  - tasks/0/logs/messages/<n>/metadata/requestUserAuthentication/liveViewUrl RAW Tilion token in benchmark run.json
  - Tilion live-view token unredacted in benchmark run record / Hub agent transcript
  - "Requesting User Assistance for <site> Login" message metadata exposes Tilion view token
tags:
  - tilion
  - secret-redaction
  - auth-assistance
  - run-record
  - benchmark-hub
sources:
  - task browser-agent-amazon-mx-buy-under-5-usd (descend-failed-neverrun-20261106 cluster I-05, campaign-20261106-110418-4087313 job r001-j0018)
  - fleet run 20261106-113552-893225
  - hub run 20261106-113552-893225-mf86afcacb5fe
  - agent 54b186a2-5c98-46d4-ad72-cef724d5477c
  - commit 6ee00fe4e (prior fix that redacted the worker-to-backend browserUrl direction only)
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_auth_assistance_result_redacts_backend_minted_tilion_live_view_token
status: fixed
---

## Problem

The run record for epoch-4 job r001-j0018 (agent 54b186a2) held 646 Tilion
live-view URLs. 640 had `token=REDACTED`. Six had a raw 107-character token, and
all six were the same value: `messages/152/metadata/requestUserAuthentication/liveViewUrl`
(the "Requesting User Assistance for amazon.com Login" TOOL message), repeated in
`logs.tree`, `owned_roots` and one `realtime_logs` broadcast. In that same metadata
block, `browserUrl` was `...live-view?token=REDACTED`. The copies were in `run.json`,
`cloudbench-run.json`, `cloudbench-runs/*/run.json`, `_batch/run.json`,
`remote-logs/runtime-evidence/run.json` and `remote-logs/cloudbench-driver.log`.
The guest `worker.log` and `backend.log` held no raw token.

A read-only check of the production Benchmark Hub
(`GET /api/benchmarks/runs/20261106-113552-893225-mf86afcacb5fe/agents/54b186a2-...`)
returned the raw token at `messages/152/metadata/requestUserAuthentication/liveViewUrl`.
ClickHouse `observability.fly_logs` had no rows for this agent or session, because
bench guest logs are not shipped there.

## Diagnosis

Critical path: the backend `createAuthAssistanceRequest` mints a fresh Tilion
view token (`freshTilionViewUrl`) and returns `handoff.liveViewUrl`. The worker
activity stores that response as `result["auth_assistance_request"]`. Then
`_visible_activity_result` redacts the result with the secret-value redactor and
**restores** `handoff.liveViewUrl` verbatim as a protocol field. The workflow tool
generator copies it into `requestUserAuthentication.liveViewUrl` on the TOOL
message. From there it reaches the DB Message row, the Supabase broadcast, the
benchmark run record and the Hub upload. `browserUrl` in the same block comes from
`result["browser_url"]`, which the activity builds with `redact_url_secrets`.

- Why 1: `_visible_activity_result` treated a credential-bearing URL as a routing ID and restored it exactly.
- Why 2: commit 6ee00fe4e established the contract that persisted Tilion URLs are redacted and the backend re-mints them for display. That fix covered only the worker-to-backend `browserUrl`. The backend-to-worker minted `liveViewUrl` was outside its regression. `test_tilion_live_view_token_is_redacted_before_persisting` states the activity-result invariant in its docstring but never drives a minted handoff back through the activity.
- Stop: the next rung would be the backend's choice to mint at create time. That is a deliberate, documented design that the attention metadata and SMS flow rely on.

Repro on the buggy revision (epoch5 base a17dbe5ae):
the regression test invoked alone (module loaded with agents/.env, then
`asyncio.run(test_auth_assistance_result_redacts_backend_minted_tilion_live_view_token())`;
the registered gate is `cd agents && python scripts/run_blackbox_tests.py spawn-browser-agent-v3`)
→ `FAIL ... AssertionError: auth handoff live view must match the persisted-URL policy`.

## Solution

`_visible_activity_result` now applies the existing `redact_url_secrets` to
`handoff.liveViewUrl` when it restores the protocol fields. This is the same policy
`browser_url` already uses: Tilion `token` is masked and `interactive`/`showControls`
stay in the URL. Steel, Kernel and other providers' live views pass through
unchanged, because the FE displays those from the persisted URL. For Tilion, the
FE's `useRefreshedAuthAssistanceUrl` already calls
`/api/auth-assistance/:id/refresh`, which re-mints the token. The fix sits at the
activity output boundary, so it covers Temporal history, the TOOL message, the
realtime broadcast, the run record and the Hub upload in one place.

The regression is
`test_auth_assistance_result_redacts_backend_minted_tilion_live_view_token`, run
through the registered `spawn-browser-agent-v3` blackbox domain. It drives the real
activity with a backend handoff for Tilion (redacted, and the token absent from
the whole result) and for Kernel (unchanged).

The cost at 10k agents is unchanged: one URL parse per auth handoff, with no
added I/O or shared state.

Not changed here: the backend still persists the raw minted URL in
`AgentAttentionRequest.metadata` (`authAssistance`/`requestUserAuthentication`
`browserUrl` and `liveViewUrl`). The R2 trace-archive end fixture copies both that
table and `Message`. Existing records keep their raw copies, and those tokens
expire 1800 s after minting.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When restoring "exact protocol" fields after a redaction pass, run any URL-typed field through the same credential-URL redactor the sibling persisted URLs use; a credential is never a routing ID.
