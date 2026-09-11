---
id: 2026-09-11-agentphone-recovery-ignored-stored-provider-ids
date: 2026-09-11
title: AgentPhone recovery ignored stored provider IDs and listed the shared account
surface: back-end
component: agentphone-provisioning
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/agentPhone.ts:provisionAgentPhoneNumber dropped phoneProviderAgentId/phoneProviderNumberId and recovered only via shared-account list
symptoms:
  - "AgentPhone recovery scan failed: AgentPhone reconciliation exceeded the 10000-agent scan bound"
  - "Browser session init failed after 5 transient-proxy retries"
  - spawn_browser_agent dies at initialization with AgentPhone recovery scan failed
  - AgentIdentity phone is NULL while phoneProviderAgentId and phoneProviderNumberId remain set
tags:
  - agentphone
  - provisioning
  - reconciliation
  - recovery
  - scan-bound
sources:
  - agent 89f3e1d7-f820-4cc6-9306-f85ed6ab0849
  - PR #1304
repro: back-end/src/tests/blackbox/agentphone-recovery-scan-bound.blackbox.ts
status: fixed
---

## Problem

Prod agent `89f3e1d7-f820-4cc6-9306-f85ed6ab0849` (goal: get the file of
_Outwitting the Devil_) spawned fourteen browser agents. Every
`spawn_browser_agent` died at initialization before opening Kobo:

`Browser session init failed after 5 transient-proxy retries:
{"error":"AgentPhone recovery scan failed: AgentPhone reconciliation exceeded the 10000-agent scan bound"}`

Path: browser `initSession` → `prepareSessionCredentials` → `getAuthOptions` →
`ensureMintedIdentity` → `createAgentPhoneNumber`. Andy's `AgentIdentity` already
had `phoneProviderAgentId=cmpn4bii60355wxj97vp6i3t8` and
`phoneProviderNumberId=cmpn4bk7i0357wxj9llzfzd77`, but `phone` was NULL, so
`persistedNumber()` refused the short-circuit. The stored number is
`status=released` (`+19129142430`). The shared AgentPhone account reports
`total=12529` agents and 50 numbers. Recovery listed that account newest-first
and threw at the 10k fail-closed bound from
`2026-09-04-agentphone-timeout-collapsed-unknown-provider-state`.

Archive searches: `AgentPhone reconciliation exceeded the 10000-agent scan bound`
and `agentphone recovery scan browser session init failed transient-proxy`. The
hit is that 2026-09-04 case. This is a relative / guardrail-miss, not a
recurrence of timeout→email-only: the 10k scan bound held; recovery that already
had keyed provider IDs still used the unsatisfiable set-scan as its success
gate.

## Diagnosis

`claimAgentPhoneProvisioning` already read `phoneProviderAgentId` /
`phoneProviderNumberId` on the identity row to decide `recoveryRequired`, then
dropped both IDs. `provisionAgentPhoneNumber` accepted only the boolean and
always called `findAgentByMarker` against the shared account. At 12,529 agents
that list cannot prove absence, so the 2026-09-04 bound throws even when a
direct `GET /agents/:id` would have recovered the stored handle.

The deepest owned cause is not "timeout too aggressive" and not a harness
contract clash. It is a keyed handle ignored for an unsatisfiable set-scan
(`problem_class: other`). Completeness of a shared-account list is not a
recovery primitive once a unique provider id exists.

Open siblings, not this first-bad write: no writer was found that nulls `phone`
while keeping the IDs; if `phone` were still set, `persistedNumber()` would
serve the released number; the shared account is an orphan graveyard (~12.5k
agents / 50 numbers); AgentPhone list pages may omit `description`, so marker
recovery can miss even a unique SHA-256.

## Solution

Owner claims now carry `existingAgentId` / `existingNumberId`. Recovery GETs
that agent; an attached active number is reused, a released/missing stored
number is replaced with `POST /numbers` on the same agent, and the shared
account is not listed. A unique SHA-256 marker hit returns immediately without
requiring a complete scan. An incomplete oversized scan with no keyed handle
still fail-closes (the 2026-09-04 invariant). `progressAgentPhoneProvisioning`
persists the provider agent id onto the lease right after `createAgent`, so a
later retry has a keyed handle.

10k-agent behavior: recovery is one GET (plus at most one number GET/POST) per
user, not O(account-agents) against one shared provider account. The 10k list
bound remains a fail-closed absence proof, never a success gate for a known id.

Number-create cleanup deletes only an agent created in the same attempt.
Recovered agents (stored id or unique marker) stay intact if `POST /numbers`
fails; email fallback is still allowed. Inbound conversation listing requires
`numberId` or `phoneNumber` before paging.

Cemented by `back-end/src/tests/blackbox/agentphone-recovery-scan-bound.blackbox.ts`
(stored IDs skip the list; later-page unique marker returns without completeness;
incomplete scan without a handle still fail-closes; recovered agent is not
deleted when number create fails). Related AgentPhone blackboxes stay green. Do
not fail-open create after an incomplete scan.

## Human feedback

None recorded.

## Reusable lesson

When a keyed provider handle already exists, recover by that key; never use an unsatisfiable shared-account scan as the success gate for a known identity.
