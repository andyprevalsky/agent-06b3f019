---
id: 2026-08-19-deploy-fence-correlates-attention-requests-through-tool-metadata
date: 2026-08-19
title: A deploy fences the browser agent's auth-assistance tool chip but leaves its attention request pending forever, because the root fence path correlated requests through tool-chip metadata instead of the durable (agentId, workflowId) relation
surface: back-end
component: stale-workflow-tools
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/staleWorkflowTools.ts attentionRequestId() — it matched only metadata.attentionRequestId and metadata.requestUserApproval.attentionRequestId, while the auth-assistance chip carries the id at metadata.requestUserAuthentication.requestId, so closeInterruptedAttentionRequest() returned before touching the row
symptoms:
  - "new code version deployed, retry this tool"
  - "Tool interrupted by deployment"
  - errorCode DEPLOY_INTERRUPTED on an action_type auth_assistance chip while AgentAttentionRequest.userResponse stays NULL
  - "Sign in to" attention request stuck unanswered with UserAuthAssistanceRequest.completedAt NULL
  - browser status bar auth prompt disappears after a deploy while the attention inbox still counts it unanswered
tags:
  - deploy
  - workflow-generation
  - auth-assistance
  - attention-requests
  - browser-agent
  - temporal
sources:
  - agent bfcfc074-0e61-41ef-b072-23376583b85a
  - agent 2dc4c954-0af7-4f50-8336-11f9925f3c05
  - agent a87224a7-f9ac-4d09-b8c6-b758f37bac38
repro: back-end/src/tests/blackbox/auth-assistance.deployment-fence-cases.ts — "deploy fence closes the pending auth assistance request with its tool chip"
status: fixed
---

## Problem

Question asked: when a browser agent is interrupted by a deploy, does it keep its
current state — for example a pending auth-assistance request?

Answer, from prod: no, and the failure is worse than "state is dropped". The tool
chip is force-closed while the request the user is supposed to answer is left open,
so the two halves of one handoff diverge permanently.

Prod evidence (`AgentAttentionRequest` joined to `UserAuthAssistanceRequest`, read
2026-08-19):

```
id                | 8b573c54-…  agent 2dc4c954-…  "Sign in to amazon.com.mx"      created 2026-07-24
  request.workflowId = 2dc4c954-…             (original generation)
  agent.temporalWorkflowId = 2dc4c954-…:replacement:c0e4cdfc-…
  userResponse = NULL   completedAt = NULL
id                | 9f60f772-…  agent a87224a7-…  "Sign in to microsoftonline.com" created 2026-08-04
  agent.temporalWorkflowId = a87224a7-…:deployment-sealed:2ea42218-…
  userResponse = NULL   completedAt = NULL
```

The matching chip for `8b573c54` shows both halves of the divergence in one row —
the fence rewrote it, and it still carries the request id the fence failed to use:

```
2026-07-24 21:12:27.237  toolStatus=IN_PROGRESS  action_type=auth_assistance
    metadata.requestUserAuthentication.requestId = 8b573c54-a3ed-43c9-b252-61b8955e0f46
2026-07-25 18:34:48.140  toolStatus=FINISHED     errorCode=DEPLOY_INTERRUPTED  deploymentFenced=true
    text = "new code version deployed, retry this tool"
    metadata.requestUserAuthentication.requestId = 8b573c54-a3ed-43c9-b252-61b8955e0f46
```

User impact: `front-end/.../browser-status-bar/useBrowserStatusBarState.ts:107`
only derives `pendingAuthAssistance` from a chip whose `toolStatus === 'IN_PROGRESS'`,
so the sign-in prompt vanishes from the UI, while
`attention-requests/repo.ts countUnanswered` keeps counting the row. If the user does
find and answer it, `providers/authAssistanceCompletion.ts:233` signals
`attentionRequest.workflowId` — the terminated generation — and the replacement
workflow has no `_signal_responses` entry to consume, because the deploy resume
payload (`providers/workflowReplacementResumeState.ts:3-31`) carries no
`signal_responses` (that key exists only on the continue-as-new payload,
`agents/workflows/agent_workflow.py:568`).

Nothing restores the other half either. The deploy resume payload
(`providers/workflowReplacementResumeState.ts:3-31`) carries counters, cost, iteration
offset and gates — no `signal_responses` (that key exists only on the continue-as-new
payload, `agents/workflows/agent_workflow.py:568`), and `_resume_interrupted_wait`
(`:2305`) re-arms only timestamp `wait_for`. The remote Steel/Kernel browser session is
neither closed nor re-attached by any fence path, and `toolsInUse` is cleared. What
survives a deploy is the DB message log plus accounting; the live browser and every
in-flight handoff do not.

The agent that prompted the question, `bfcfc074-0e61-41ef-b072-23376583b85a`
(Mercado Libre checkout, 2026-08-11), shows the surrounding blast radius: four
`DEPLOY_INTERRUPTED` chips at 21:54:45, then FAILED at 22:01:13 with
`temporalWorkflowId = …:deployment-sealed:f9206d56-…`. It happened to be at the
auth-guard's "Automated authentication options remain: password" state rather than a
created request (`UserAuthAssistanceRequest` = 0 rows for it), so it is the
motivating report, not the repro subject.

## Diagnosis

Critical path: deploy cutover → `agentRestartService.prepareAgentWorkflowReplacement`
→ `sealClaimedReplacement` → `workflowReplacement.sealStaleWorkflow` →
`staleWorkflowTools.finalizeInterruptedWorkflowTools(agentId, staleGeneration, snapshot)`.

Step 5a ladder:

1. The pending auth-assistance request stayed open after a deploy.
2. `closeInterruptedAttentionRequest` never ran an update for it, because
   `attentionRequestId(metadata)` returned `null`. *Evidence: the function reads only
   `metadata.attentionRequestId` and `metadata.requestUserApproval.attentionRequestId`
   (`staleWorkflowTools.ts:33-39`); the auth-assistance chip is emitted with
   `metadata.requestUserAuthentication.requestId`
   (`agents/domains/spawn_browser_agent_v3/handler.py:9573-9587`), confirmed on the
   fenced prod row above.*
3. That was possible because the one shared fence routine correlated attention
   requests through **tool-chip metadata**, while the durable ownership relation
   `AgentAttentionRequest(agentId, workflowId)` already exists. *Evidence:
   `finalizeInterruptedWorkflowTools` has five callers —
   `agentRestartService.ts:160` (root deploy), `workflowDescendantCleanup.ts:283`,
   `descendantWorkflowStart.ts:411`, `workflowTerminalCleanup.ts:274`, and
   `workflowLivenessReconciler.ts:143` — and all five inherited the metadata matcher.
   Two of them happened to also run a blanket `updateMany` by
   `(agentId, workflowId = generation, userResponse: null)` inside their own
   transaction (`workflowDescendantCleanup.ts:241-248`,
   `descendantWorkflowStart.ts:347-356`), which accidentally masked the defect for
   descendants only. Terminal cleanup and the liveness reconciler had no backstop at
   all, so agents that never saw a deploy were orphaned the same way.*

Rung 4 would be "the attention-request contract has no single owner", which is what
the rung-3 fix establishes. Stop at 3.

Deepest owned cause: one shared "close what this sealed generation was waiting on"
routine that silently no-ops for every request kind its matcher does not enumerate,
plus a redundant blanket close on two of five callers that hid the gap from the two
paths most likely to be exercised in testing. `requestUserApproval` happened to be
enumerated, `requestUserAuthentication` did not, and nothing failed loudly.

A second, independent instance of the same class was found while verifying the fix:
`workflowLivenessReconciler.sealAgent` passed `candidate.agentId` as the workflow
generation instead of `candidate.workflowId`, the generation it had just read as
closed. For any agent already on a `<agentId>:replacement:<token>` generation, both
the chip capture (`staleWorkflowTools.ts` filters
`messageWorkflowGeneration !== generation`) and the attention close matched nothing,
so a terminated replaced agent left its chip IN_PROGRESS and its request pending
forever — the reported symptom, with no deploy involved.

## Solution

Deleted the correlation surface rather than adding a third key to it
(`staleWorkflowTools.ts`): `attentionRequestId()` and
`closeInterruptedAttentionRequest()` are gone, replaced by one exported
`closeInterruptedAttentionRequests(client, agentId, workflowGeneration)` that closes by
the durable relation. `finalizeInterruptedWorkflowTools` calls it once after fencing
the chips, so all five callers inherit the correct rule; the two descendant paths keep
their in-transaction call (idempotent CAS on `userResponse IS NULL`) because it runs
under the generation lock their surrounding seal already holds.

Three constraints the naive blanket close would have violated, each handled explicitly:

* **Gate rows are excluded** (`gateKey: null` in the predicate).
  `AgentAttentionRequest` is a deliberate cross-agent fan-in point: agents that hit the
  same gate collapse onto one PENDING row and the rest live in `metadata.gateWaiters`
  (`domains/attention-requests/service.ts` `joinGateAsWaiter`). Answering that row on
  behalf of one fenced agent would strand every still-live waiter, because
  `gateResolution.resolveAndSignal` only signals waiters while `userResponse IS NULL`.
  Gates belong to the gate lifecycle and stay open. The old metadata matcher *did* reach
  gate chips (they carry `metadata.attentionRequestId`), so this also closes a latent
  cross-agent defect rather than merely avoiding a new one.
* **Lock ordering is preserved.** `gateResolution.ts` documents that deployment cleanup
  takes `lockAgentWorkflowGeneration` before terminalizing attention rows; the new
  root-path close runs inside `runTransactionWithRetry` taking that lock first.
* **The liveness reconciler now reconciles the right generation** — `sealAgent` passes
  `candidate.workflowId` instead of `candidate.agentId` to both
  `captureInProgressWorkflowTools` and `finalizeInterruptedWorkflowTools`.

Sibling failures this also prevents: every other attention-request kind raised from a
browser chip — payment-card requests, passkey handoffs, and any future
`requestUser*` shape — would have been orphaned identically, on all five callers.
None of them needs a new matcher now.

The completion route was the mirror image of the same defect and is fixed with it.
`completeAuthAssistanceForUser` wrote the attention answer with an unconditional
`update`, so a user who finished signing in *after* the fence erased the
DEPLOY_INTERRUPTED marker and then signaled the terminated generation. It now
compare-and-swaps on `userResponse IS NULL` — the same predicate every other resolver
uses — keeps the credential capture (`completedAt`, `SteelSessionAuth`) because that is
the whole point of the user signing in, and skips the doomed signal in favour of
`resumeAgentWorkflow`, logging that the handoff outlived its generation.

Regression: `back-end/src/tests/blackbox/auth-assistance.deployment-fence-cases.ts` →
"deploy fence closes the pending auth assistance request with its tool chip". It
creates the request through the real `POST /api/auth-assistance` route, posts an
IN_PROGRESS chip carrying `requestUserAuthentication.requestId` (fixture hand-copied
from `handler.py`), advances `temporalWorkflowId` to a `:replacement:` id, and calls
`finalizeInterruptedWorkflowTools` unchanged. Two fixtures guard the edges: an
approval-shaped request that must be closed (it passed pre-fix, proving the fence
itself was healthy and only auth assistance was missed) and a `gateKey` row that must
stay open. Assertions compare against `DEPLOY_INTERRUPTED_TOOL_MESSAGE` and require a
non-null row, so a deleted or missing row fails rather than passes.

Scope honestly: post-fix the close no longer reads chip metadata, so this test cements
the invariant "a sealed generation leaves no non-gate request pending" rather than the
specific metadata shape. It does not drive the real cutover
(`prepareAgentWorkflowReplacement → sealClaimedReplacement → sealStaleWorkflow`); it
invokes the fence routine those paths share.

Pre-fix: `✗ deploy fence closes the pending auth assistance request with its tool chip
(346ms) — Deploy fence closed the auth assistance chip but left its attention request
pending (userResponse=null)`, `Passed 10/11`.
Post-fix, same command and unweakened assertion: `Passed 11/11`; the `agents` domain
(which owns the liveness-reconciler cases) also passes.

The suite is auto-discovered by `src/tests/blackbox/run.ts` (filename-based) and runs
under `/deploy` Step 5a's full back-end blackbox suite.

10k-agent behavior: one bounded `updateMany` per sealed generation, replacing up to N
per-tool-call updates — strictly fewer statements than before. The common predicate is
`workflowId = <generation>`, served by `AgentAttentionRequest_workflowId_idx`; there is
no `agentId` index, so the null-generation path (an abandoned descendant start only)
scans, which is acceptable at its frequency. Excluding `gateKey` rows keeps the write
strictly per-agent, so no cross-agent fan-in row is touched.

## Human feedback

The user asked "does a deploy-interrupted browser agent maintain its state, like an
auth assistance request?" — a question, not a bug report; the orphan was found by
answering it against prod. On seeing the diagnosis plus two recorded follow-ups, the
instruction was "fix all issues then /deploy", so the completion-route clobber and the
browser-session leak (see
[[2026-08-19-browser-session-release-attached-to-deletion-not-termination]]) were
landed in the same change rather than deferred.

## Reusable lesson

Close a fenced workflow generation's pending work through the durable ownership
relation that already exists, never by pattern-matching ids out of message metadata —
a matcher that enumerates payload shapes silently no-ops on the next shape.
