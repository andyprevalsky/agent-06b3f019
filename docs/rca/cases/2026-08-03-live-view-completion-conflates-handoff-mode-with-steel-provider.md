---
id: 2026-08-03-live-view-completion-conflates-handoff-mode-with-steel-provider
date: 2026-08-03
title: Auth-assistance completion treated every live-view handoff as a Steel session and rejected Kernel
surface: back-end
component: auth-assistance-completion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/authAssistanceCompletion.ts completeAuthAssistanceForUser — live_view completion requires provider steel instead of separating generic handoff completion from Steel-only credential persistence
symptoms:
  - "POST /api/auth-assistance/9f60f772-7202-4ea5-b46c-cbaed5b96b74/complete 400 (Bad Request)"
  - "Steel context is not available for this live_view request"
  - "Failed to complete authentication assistance" after clicking Start Agent
tags:
  - auth-assistance
  - kernel
  - live-view
  - provider-contract
sources:
  - agent a87224a7-f9ac-4d09-b8c6-b758f37bac38
  - commit 36131c535e45cabdb2089348f964cabf7070d6a5
repro: back-end/src/tests/blackbox/auth-assistance.provider-cases.ts
status: fixed
---

## Problem

Clicking Start Agent for the pending Microsoft login repeatedly posted the
auth-assistance completion route, which returned 400 and left the request
uncompleted. The production row for request
`9f60f772-7202-4ea5-b46c-cbaed5b96b74` was an incomplete `live_view` request
bound to browser session `968dfe71-4f6c-479d-9e64-d99944871195`. That session
was `ACTIVE`, used provider `kernel`, and had a non-empty persistent provider
profile. The message diagnostics independently identified the browser replay
as Kernel.

The owning-boundary reproduction command was:

`cd back-end && bash scripts/run-blackbox-tests.sh auth-assistance`

On the buggy revision the final acceptance matrix completed 8/10 cases. Plain
Kernel completion and Steel-to-Kernel completion both failed with `Expected
status 200, got 400: {"error":"Steel context is not available for this
live_view request"}`. Kernel-to-Steel already passed because the completion
path resolved the stable browser-session row's current Steel profile. The
companion Steel-without-profile case also passed, proving the fail-closed Steel
behavior the fix had to preserve.

## Diagnosis

`BrowserViewPanel` correctly maps Start Agent to
`POST /api/auth-assistance/:id/complete` while auth assistance is pending. The
route reaches `completeAuthAssistanceForUser`, resolves the stable browser
session, and then derives `steelContextId` only when
`session.provider === 'steel'`. A Kernel session therefore deterministically
becomes `missing_steel_context`, even though the session exists, belongs to the
user, is active, and has its own persistent provider profile. The API maps that
internal status to the exact observed 400.

The local blackbox seeded the same `live_view` plus Kernel-provider boundary and
failed with `Expected status 200, got 400: {"error":"Steel context is not
available for this live_view request"}`. The deepest owned cause is a provider
contract inconsistency: the generic `live_view` handoff mode was used as a
proxy for the Steel provider, coupling generic completion/resume to a
Steel-only credential snapshot side effect. Existing coverage created only
Steel sessions, so it never exercised the provider-independent endpoint with
Kernel.

This is an owning-boundary replay, not a claim that the blackbox provisions a
real Kernel browser or signals live Temporal. It preserves the exact persisted
request/session shape consumed at the first-bad backend boundary; the
production DB row and agent diagnostics prove that the real upstream flow
delivered that shape.

Archive searches were `Steel context is not available for this live_view
request`, `click Start Agent auth assistance complete 400 live_view`, and
`live_view Steel auth assistance`, plus a literal repository/archive grep. No
case had this error or first-bad boundary. The closest case,
`2026-07-13-stale-cached-provider-session-id-spawns-second-browser`, is a
relative involving auth-handoff provider identity, not a recurrence: it failed
because the resumed activity trusted a stale session ID, whereas this incident
fails inside provider-specific completion after the correct stable session is
resolved.

## Solution

`completeAuthAssistanceForUser` now treats the stable browser-session row as the
provider authority at completion time. Kernel completes and resumes without a
Steel side effect; Steel still requires the current bound Steel profile and
then performs the existing `SteelSessionAuth` upsert plus `steel_session`
credential message. Unknown providers and missing sessions remain fail-closed.

The permanent blackbox covers plain Kernel, Steel-to-Kernel after the handoff
was created, Kernel-to-Steel after the handoff was created, Steel idempotency,
and Steel-without-profile rejection. The same command that failed 8/10 now
passes 10/10. This prevents stale request-level provider session IDs from
overruling a mid-run provider switch. The change remains constant work per
completion (one session lookup and the existing request/attention mutations)
and adds no shared state, polling, fan-in, or agent-count-dependent work at 10k
agents.

## Human feedback

The user clarified that the error occurred when clicking Start Agent, then
required coverage for browser agents switching Steel-to-Kernel or
Kernel-to-Steel mid-run.

## Reusable lesson

Keep handoff lifecycle contracts provider-independent, and isolate provider-specific credential persistence behind the resolved session provider.
