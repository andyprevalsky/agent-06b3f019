---
id: 2026-10-14-admin-inspection-mounted-owner-only-controls
date: 2026-10-14
title: Read-only admin inspection still mounted agent mutation controls
surface: front-end
component: terminal account inspection controls
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentChatArea used inspection_context only for an identity badge and mounted the writable InputArea for a foreign account run
symptoms:
  - Failed to pause agent
  - POST /api/agents/ae17b024-5287-4199-84d0-6cce3bd1765d/pause returned 404
  - Agent detail GET returned 200 while pause POST returned 404
  - Read-only inspection exposed Stop and pending approval controls
tags:
  - mobile
  - agent-pause
  - admin-inspection
  - authorization
  - read-only
sources:
  - agent ae17b024-5287-4199-84d0-6cce3bd1765d
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
  - PR #1511
repro: front-end/src/tests/blackbox/admin-agent-inspection.blackbox.tsx
status: open
---

## Problem

Retained Render logs record three pause POSTs at 17:33:52.159,
17:33:58.082 and 17:33:59.497 UTC returning HTTP 404 in approximately 25 ms.
Each request completed User.findUnique and Agent.findFirst, with no pause
transaction, Agent update or Temporal signal. Adjacent detail GETs returned
200 every two seconds. The root belongs to c49b4ce3-3489-499d-bfbd-846d04ba6275;
its deletion at 17:34:50.099 UTC was later than these failures.

The retained HTTP logs do not record the authenticated caller. Foreign admin
inspection is a strongly supported inference from the read/write pattern,
not a captured caller identity. The confirmed frontend defect is independently
reproduced using the backend's explicit foreign inspection_context contract.
Do not call this a mobile transport failure or blame Temporal or later deletion.

## Diagnosis

Critical path: mobile Stop control -> useAgentActions.handlePauseAgent ->
pauseAgent HTTP request -> authenticated owner-filtered findAgent -> 404 ->
generic failure toast. resolveAgentReadAccess deliberately allows an admin to
read a foreign run; pauseAgentForUser deliberately requires ownership. The
detail response supplies inspection_context and the badge says read-only,
but AgentChatArea did not use it to select the read-only rendering branch.
refreshAgentDetail catches its own errors, so its failure cannot explain
this toast. The failure is before workflow signal delivery.

The deepest owned frontend cause is using access context as decoration rather
than deriving which interaction surfaces mount. The permanent real-Terminal
reproduction exposes both an editable composer and a foreign pending-approval
button before the fix. This is a novel case; archive searches used Failed to
pause agent; mobile agent pause failure not found; and ownership/inspection
vocabulary. Related pause/execution cases have different first-bad boundaries.

## Solution

The local repair reuses AgentChatArea's existing shared-recording read-only branch
for foreign inspection_context. It omits the composer, Stop, settings, gate
and approval subtree and directs the operator to switch to the account for
control. Selecting an owned run restores its input and controls. Backend
ownership checks are preserved. Independent review identified live browser
controls outside that subtree. The final repair derives browser interactivity
from the same inspection context, preserves viewing/progress/recordings, omits
Take control, Hand back, Start Agent, write approval and auth completion actions,
and renders passive browser URLs and inert iframe input. Inspection skips
automatic control recovery/renewal and auth-session refresh. An in-flight control
GET checks its cancelled ownership before issuing a later POST.

The first permanent real-Terminal reproduction failed 2 tests and passed 3 in
20.21 seconds; the editable textarea and Confirm foreign action button were
present. Its initial candidate passed the same 5 tests in 16.38 seconds.
The strengthened paired command is cd front-end && npx vitest run
src/tests/blackbox/admin-agent-inspection.blackbox.tsx
src/tests/blackbox/browser-live-view-binding.blackbox.tsx. The exact original
AgentChatArea/types baseline failed 8 tests and passed 11 in 11.50 seconds;
the mobile fixture clicked the actual Stop button, observed the captured
404 and the exact Failed to pause agent toast, then failed the no-mutation
assertion. Browser scenarios also exposed interactive controls. Final candidate:
20 tests passed in 12.24 seconds.

Two more causal controls were run before their corresponding changes. A delayed
control GET resolving after a switch into inspection issued a /control POST:
failure in 9.03 seconds, same assertion passing in 9.90 seconds. The waiting
auth fixtures observed an automatic /auth-assistance/.../refresh-session POST
in inspection: 2 failed and 4 passed in 9.90 seconds; the unchanged 6 cases
passed in 9.25 seconds after disabling that mutating refresh.

Final npm run test:coverage discovered the new regressions and passed 157 files,
2744 tests with 3 skips in 142.44 seconds. Coverage was 81.04% statements,
73.17% branches, 81.43% functions and 83.35% lines. Targeted ESLint and
git diff --check passed. No frontend source changed during that final run.

The additional app-tsconfig check reported the same 218 diagnostics on HEAD
and the candidate; no added or removed diagnostic keys. It is not a passing
typecheck and is retained as a deploy-verification limitation. This case remains
open pending deployment. The user's subsequent direction authorizes preserving
actual messages and native schema updates in the combined browser repair. No live agent was paused or modified.

At 10,000 agents, deriving view interactivity from the already-loaded selected
agent context adds no query, subscription, polling loop or shared contention.
Golden references inspected: codex/codex-rs/tui/src/bottom_pane/chat_composer.rs:273
and :1913 use input_enabled to ignore input and show a disabled placeholder;
openclaw/ui/src/lib/session-method-access.ts:90-108 scopes session mutations
to permitted owner/admin authority; hermes-agent/hermes_cli/cli_tui_mixin.py:2230 binds
read-only input to its blocking state. Those are authority/state analogs, not
evidence about this incident's unidentified caller. Claude's PromptInput was
searched for an admin-inspection analogue and none was found.

## Human feedback

The user reported the mobile pause error and asked to continue. No request to
weaken account ownership or grant cross-account mutation was recorded. The user
subsequently asked for genuine-message preservation and schema updates without
harness injections; frontend schema display is checked against accepted native
schema revisions.

## Reusable lesson

Derive available agent controls from the response's access context and preserve owner-only mutations when displaying another account's run.
