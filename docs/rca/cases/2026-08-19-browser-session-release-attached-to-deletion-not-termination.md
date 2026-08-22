---
id: 2026-08-19-browser-session-release-attached-to-deletion-not-termination
date: 2026-08-19
title: Browser sessions leak forever because release is hung off agent DELETION instead of agent TERMINATION, so every agent that merely finished left a paid remote browser running
surface: back-end
component: agent-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentStatusService.ts runTerminalAgentCleanup — the terminal hook released purchase cards and finalized the trace archive but never released browser sessions; the only caller of providers/agentCleanup cleanupAgentSessions was agent deletion
symptoms:
  - BrowserSession rows stuck status ACTIVE with closedAt NULL after the agent reached COMPLETED / FAILED / COST_LIMIT_REACHED
  - Steel or Kernel browser still billing after its agent finished
  - "Workflow ended without reporting a result (terminated or lost). Sealed by liveness reconciler." with an ACTIVE BrowserSession still attached
  - no cron or reconciler closes stale ACTIVE BrowserSession rows
tags:
  - browser-session
  - kernel
  - steel
  - resource-leak
  - agent-lifecycle
  - cost
sources:
  - agent bfcfc074-0e61-41ef-b072-23376583b85a
  - agent 1961e0df-d87a-4989-95b5-0ced731955e2
  - agent 937a34d1-465c-407d-94e3-8d03575443e9
repro: back-end/src/tests/blackbox/agents-terminal-browser-release.cases.ts — "PATCH /:id/status <TERMINAL> releases the agent's browser sessions"
status: fixed
---

## Problem

Found while diagnosing
[[2026-08-19-deploy-fence-correlates-attention-requests-through-tool-metadata]]: prod
agent `bfcfc074-0e61-41ef-b072-23376583b85a` was sealed FAILED on 2026-08-11, and its
`BrowserSession` row `5ea47deb-…` was still `status = ACTIVE, closedAt = NULL` eight
days later.

It was not alone. Auditing prod on 2026-08-19:

```
12 BrowserSession rows: status ACTIVE, closedAt NULL, agent already terminal
  provider = kernel for all 12; oldest createdAt 2026-07-24
  by agent status: COST_LIMIT_REACHED 7, COMPLETED 4, FAILED 1
  all 12 belong to ROOT agents (parentAgentId IS NULL)
```

Every one of those is a rented remote browser that nothing ever told the provider to
stop billing for.

## Diagnosis

Step 5a ladder:

1. Terminal agents keep `ACTIVE` browser sessions.
2. Nothing releases them. The only backend function that does —
   `providers/agentCleanup.ts` `cleanupAgentSessions` — has exactly two callers:
   `domains/agents/agentLifecycleService.ts` (`deleteAgentRecursive`) and
   `providers/smsSupervisor/supervisorTools.helpers.ts` (SMS "kill agent").
   *Evidence: repo-wide grep for `cleanupAgentSessions`; the leaked agents were never
   deleted, so neither ever ran.*
3. The happy-path release is the Python browser activity voluntarily calling
   `POST /api/browser-session/close` (`agents/domains/spawn_browser_agent_v3/repo.py`
   `close_browser_session`). All five of its call sites live inside the activity's
   `try` body; the `finally` at `handler.py` only tears down local Playwright state via
   `_schedule_browser_cleanup`. A Temporal terminate executes no activity code, a
   worker SIGKILL skips it, and the HTTP call itself swallows every error to a warning.
   *Evidence: `drain_background_browser_cleanups` explicitly logs "some sessions may be
   orphaned".*
4. And there is no backstop: none of the seven jobs in `serverCron.ts` touches
   `BrowserSession`, and no reconciler closes stale rows. *Evidence: grep for
   `browserSession` across `workflowTerminalCleanup.ts`,
   `workflowDescendantCleanup.ts`, `workflowLivenessReconciler.ts` — zero hits.*

Deepest owned cause: **release was modelled as a consequence of deletion, a user
action most agents never receive, rather than of termination, which every agent
reaches.** The backend already had the right hook —
`agentStatusService.runTerminalAgentCleanup`, fired on the first root terminal
transition — and it released purchase cards and finalized the trace archive but not the
browser. The gap was a missing line in an existing contract, not a missing contract.

## Solution

Extracted `releaseAgentBrowserSessions(agentId)` from `cleanupAgentSessions`
(`providers/agentCleanup.ts`) and called it from the two places that actually observe
an agent stopping:

* `agentStatusService.runTerminalAgentCleanup` — every COMPLETED / FAILED /
  OUT_OF_CREDITS / COST_LIMIT_REACHED transition written through `updateAgentStatus`.
  Injectable via `dependencies.releaseBrowserSessions`, matching the existing
  `cleanupPurchaseCards` seam.
* `workflowLivenessReconciler.sealAgent` — the out-of-band seal writes the row with a
  bare `updateMany`, so it bypasses that hook entirely. This is the path that killed
  `bfcfc074-…`.

Both are best-effort: a provider outage logs and continues, so a dead Kernel can never
block an agent from reaching its terminal state. Release itself is already idempotent —
`closeSession` tolerates a 404 from Steel/Kernel and updates the DB regardless.

Sibling failures this also prevents: every terminal path that is not a deletion —
cost-limit trip, out-of-credits, normal completion, workflow terminate, worker kill —
now releases the browser, and none of them depended on the Python activity's
cooperation.

Deliberately not done: no periodic sweeper. Both writers of a terminal agent row are
now hooked, so a sweeper would be dead code today; if a third writer ever appears, the
correct fix is to hook it, not to poll.

Regression: `back-end/src/tests/blackbox/agents-terminal-browser-release.cases.ts`
seeds an ACTIVE session, PATCHes the agent to a terminal status through the real route,
and asserts `status = CLOSED` and `closedAt` non-null — once for COMPLETED and once for
COST_LIMIT_REACHED, so the assertion is about the terminal *class*, not one status.

Pre-fix: both cases fail with `Terminal COMPLETED left the browser session open
(status=ACTIVE)`. Post-fix, unchanged: both pass, `agents` domain green.

10k-agent behavior: one indexed `findMany` on `BrowserSession.agentId` plus one
provider call per still-open session, fired once per agent at its single terminal
transition — bounded by sessions that agent opened, never by total agent count. It
replaces an unbounded, permanently-growing population of orphaned paid browsers, so
it strictly reduces steady-state cost.

## Human feedback

The user asked for both remaining issues from the prior RCA to be fixed and shipped
("fix all issues then /deploy"), which is what promoted this from a recorded follow-up
to a landed fix.

## Reusable lesson

Release a rented external resource on the owner's TERMINATION, never on its deletion —
deletion is an optional user action, so anything hung off it leaks for every object
that simply finishes.
