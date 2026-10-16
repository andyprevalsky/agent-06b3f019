---
id: 2026-10-14-inspection-context-did-not-reach-approval-controls
date: 2026-10-14
title: Read-only account inspection displayed approval controls that the current session could not authorize
surface: front-end
component: terminal / account inspection / approval controls
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentChatArea rendered mutation controls from inspected messages without propagating inspectionContext; attribution to the historical phone session remains incomplete
symptoms:
  - "phone website approval produced error toasts"
  - "POST /api/attention-requests/cmv8b7buz0l7hzjsggc1gqgfs/respond -> 403"
  - "Failed to send approval"
  - "Inspecting user account · Read-only"
tags:
  - approvals
  - inspection
  - identity
  - phone
  - http-403
sources:
  - agent 389d96c6-4c8b-4729-a201-bbc73499f662
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
repro: front-end/src/tests/blackbox/admin-agent-inspection.blackbox.tsx
status: open
---

## Problem

Retained backend traces show four approval POSTs for the second attention request returned 403 at 16:30:21.046, 16:30:26.556, 16:30:27.583 and 16:30:32.029 UTC on October 14. Their request IDs are `0af4b8c250af`, `3fa34ec7dd14`, `8c7112a3f177` and `16181818059a`; each took 30–34 ms. The first trace contains successful User.findUnique and AgentAttentionRequest.findUnique followed by 403. SMS resolved the same request at 16:30:39.090. These were not transaction timeouts or successful approvals followed by a toast failure.

The request owner is the current Andy account. Two local User records share the phone number; Supabase currently maps it to the legacy ID, while Rose can mint sessions for local users independently of auth.users. Retained HTTP traces did not preserve authenticated subject/owner comparison, and no recent login subject was recovered. This does not establish which historical browser session or component was used. The API's owner check correctly protects a genuinely foreign viewer. No accounts were merged, no sessions minted, no production approval submitted, and no authorization bypass added during this RCA.

## Diagnosis

A reproduced source path is: administrator GET agent detail -> inspection_context plus foreign-owner messages -> TerminalContent approval derivation -> AgentChatArea approval controls -> POST with unchanged current-session JWT -> backend request-owner check -> 403 -> generic frontend toast. Admin detail reads deliberately allow account inspection and expose owner identity; the frontend displayed a read-only badge, but did not carry that capability into mutation rendering. The backend's denial is correct. The owned UI defect is that read-only context failed to constrain actions, not that unrelated identities should share authorization because their phone/name happens to match.

The permanent full-Terminal reproduction populated the captured receipt attention metadata with a read-only inspection context and asserted that Accept/Reject were absent and account switching was available. On baseline it failed because an enabled Accept button existed. The paired signed-in-owner case remained actionable. An initial incomplete test fixture lacked the real isUserAttentionMessage/text projection fields and produced fake missing-control failures; that fixture was corrected before the recorded valid baseline failure. Those preliminary failures are not incident proof.

Archive searches: `Failed to respond to attention request`, `same approval repeat retries website phone write lock`, `admin inspection read-only approval`, `duplicate phone login user identity`, and `inspection read-only approval HTTP 403`. The transaction-timeout and account-control-overlay cases are relatives; their boundaries do not explain the captured rapid 403. No proven recurrence was identified. Unordered duplicate-phone lookup in OTP and SMS remains a separate unresolved provenance/identity-policy lead; oldest/newest selection would invent a product policy.

## Solution

Local draft only, pending the combined change's prompt approval and deployment. AgentChatArea replaces mutation input with an explicit account-switch notice while inspection context is present. The switch uses the existing reversible administrator session flow and preserves the selected agent deep link, so the operator can then approve as the owning account. Browser-inline write approval similarly hides its mutation controls during inspection. Normal own-account approval remains enabled. Owner checks are unchanged. Backend ownership rejection records safe opaque subject/owner/request/agent IDs for a future occurrence, and the approval UI now surfaces the actual server explanation.

Executed owning command, from `front-end/`: `npx vitest run src/tests/blackbox/admin-agent-inspection.blackbox.tsx`. Valid baseline: one failure, four passes, 12.95 s, failure at the no-Accept assertion. Fixed draft: five passes, 12.01 s, explicit owner switch with the same agent ID and zero approval POSTs while inspecting. Additional `admin-switch-survives-reload`, `low-cov-chips`, and `terminal-components` suites passed together: 125 passes and one declared skip across four files in 15.80 s. Frontend and backend typechecks passed; targeted lint passed. The permanent file is automatically discovered by Vitest and deploy's frontend coverage gate.

Golden references: `codex/codex-rs/core/src/tools/network_approval.rs:670` scopes approved capability to the environment/protocol/host instead of treating readable state as write authority; `claude-code-src/src/utils/permissions/PermissionPromptToolResultSchema.ts:95` applies explicit granted permissions. Rose converges on propagating the existing capability boundary, with explicit identity switching for administrators.

At 10k agents this is a local render branch and a user-initiated existing switch; it adds no polling, shared approval topic, background task, database fan-in, or per-agent server work during rendering. The server audit occurs only on a refused write. Neither this test nor current auth mapping proves the historical phone JWT. That attribution remains open; the source defect and its guarded UI behavior are locally proven, and no production fix is claimed until deployed.

## Human feedback

The user reported phone website error toasts when approving, alongside repeated semantic approval requests, and requested continuation. A text clarification about the phone account session was offered; no answer was received before this case was recorded.

## Reusable lesson

Carry read-only inspection capability into every approval action and require an explicit account switch before submitting an owner-authorized response.
