---
id: 2026-09-03-agent-ui-writes-not-bound-to-live-selection
date: 2026-09-03
title: Agent UI writes were not bound to the live selected-agent identity
surface: cross
component: agent-context
classification: our-bug
problem_class: other
first_bad_boundary: front-end/src/features/agent-context/hooks/useRealtimeSubscription.ts:createRealtimeHandlers
symptoms:
  - leaks from one agent-id to another's page
  - stale agent title or message appears after switching agent-id
  - Mac app shows data from the previously selected agent
  - browser cursor or live-view URL survives an agent-id transition
tags:
  - react
  - realtime
  - agent-isolation
  - stale-callback
  - mac-app
sources:
  - commit d1615134058406b800aa3c8db34f5c40e1616182
  - commit b024ea1f5b7486764b951262fe1227e44fc0d617
  - PR #1246
repro: front-end/src/tests/blackbox/agent-isolation.blackbox.tsx
status: fixed
---

## Problem

After navigating from agent A to agent B, the shared web Terminal could render
late data from A on B's page. The Mac app was exposed to the same failure because
its renderer aliases `@` directly to `front-end/src` and mounts the same Terminal
and AgentContext.

The installed Mac logs retained no agent-navigation or realtime-payload fields,
so they could not identify a specific production event. The failure was instead
proved at the owning boundary with deterministic blackbox races. Before the fix,
`agent-isolation.blackbox.tsx` changed the visible B title to `LEAKED TITLE FROM
A` when an already-queued A callback fired, and it rendered a response whose
requested ID and returned `agent_id` differed. Separate pre-fix tests showed a
late A detail refresh committed after B was selected and a late A ancestor-tree
fallback replaced B's breadcrumb. Adversarial review found the same ownership
defect in browser cursor callbacks, auth live-view URL state, the merged
sub-agent-message cache, and the agent-tree hook before this case was closed.

## Diagnosis

Before forming the hypothesis, the required archive searches were run:

```text
$ python3 scripts/rca_archive.py search "agent-id page frontend mac-app leak another agent"
No exact archived selection-isolation case; results were Mac/frontend identity relatives.

$ python3 scripts/rca_archive.py search "cross-agent stale state URL navigation messages realtime subscription"
Related cases: 2026-04-13 realtime INSERT dedup and 2026-07-13 browser live-view URL delivery order; neither owned the selected-agent transition boundary.
```

The archive classification is related, while the Git-history classification is
an exact recurrence: the earlier processing gate for cross-agent contamination
was accidentally neutralized and no permanent selection-race test survived.

`createRealtimeHandlers` closed over the agent ID that existed when a Supabase
subscription was created. Its payload checks therefore compared an A payload to
the captured A ID even after the live selection had become B. Unsubscribing the
A channel could not cancel a callback that Supabase or the JavaScript queue had
already delivered. A callback could also pass a pre-setter check while A was
selected, then have its React functional updater execute after B was selected.

The same missing identity contract existed in sibling asynchronous and local-state paths:
detail refreshes wrote through raw context setters, ancestor fallback checked
its cancellation flag before but not after its nested await, API consumers
trusted a returned `agent_id` that could differ from the requested ID, and the
MessageList animation queue survived selection changes. Browser cursor events
did not validate their payload agent, refreshed auth URLs and merged spawn-tree
messages retained the prior render's state, and `useAgentTree` returned its
previous bus map while a new bus initialized.

Git history proves this was a recurrence. Commit
`d1615134058406b800aa3c8db34f5c40e1616182` added a global processing gate for
this exact contamination class. Commit
`b024ea1f5b7486764b951262fe1227e44fc0d617` removed the statement that closed
that gate during selection changes while leaving callbacks dependent on it.
There was no permanent cross-agent race test, so the regression landed.

The deepest owned cause was unscoped asynchronous state ownership (a missing
`problem_class` taxonomy bucket): agent selection identity and agent view state
were separate contracts. Agent-scoped work and caches could write to shared,
unkeyed React state without proving that their owner was still the live selection.

## Solution

Every realtime subscription now owns an agent-scoped cancellation token and
checks it against the live `selectedAgentIdRef`. All React setters used by that
subscription are wrapped so the identity is checked inside the final functional
updater, not only when the callback starts. The final predicate is pure so React
can replay an updater without repeating diagnostics or mutating subscription
state. Reconnect timers, subscription
resolution, connected backfill, disconnected polling, and stream-cleanup timers
use the same boundary. A disconnected detail request is abortable and bounded by
a timeout, so one hung fetch cannot suppress every later reconciliation poll.

Agent detail APIs reject a response whose `agent_id` differs from the requested
ID. AgentContext exposes `applyAgentDetail(agentId, response)` instead of raw
agent/message setters, and the scoped method rechecks identity inside each state
updater. Terminal refreshes, ancestor resolution, and MessageList animation
state now discard or clear work owned by the old selection. The entire browser
and MessageList subtrees remount on selection, while their cursor,
refreshed-URL and spawn-tree-cache internals also carry explicit owner identities.
Agent-tree connection, pending-connect, health, reconnect, and callback ownership
live on a shared bus generation so one consumer can leave without silencing
another; each consumer still scopes its final React setter. Cursor callbacks require live selection, channel identity,
task identity, and payload `agentId`; their final state updater and animation
frames recheck that owner.

The regression coverage preserves every realtime handler after unsubscribe,
updater-after-switch, delayed subscription resolution, connected and
disconnected backfills, stream-cleanup timeout, mismatched response, delayed
refresh, delayed ancestor, animation buffer, browser cursor/auth URL,
spawn-message cache, and agent-tree transition races. The delayed-refresh
fixture supplies both the old raw setters and the new scoped callback, so it
fails against the old implementation rather than passing on a caught fixture
error. Additional review regressions cover sub-agent animation-buffer switches,
missing-model reset, stable empty-tree identity, hung disconnected fetches, and
initial API tree snapshots racing newer realtime nodes.

Selection transitions and stale-work discards now emit identity-only console
diagnostics (`previousAgentId`, `nextAgentId`, owner, active ID, and surface),
which the Mac console log captures without recording message content. The
isolation work is constant-time per event and keeps one subscription and one
small state set for the viewed agent; it does not fan out across an account's
agents, so 10,000 stored agents have the same view cost as one.

## Reproduction and verification

Before the fix (captured during the red checkpoint, before the delayed-refresh
test was moved from `terminal-hooks` into the permanent isolation file):

```text
$ npx vitest run src/tests/blackbox/agent-isolation.blackbox.tsx
Test Files  1 failed (1)
Tests       2 failed (2)
Observed: B title became "LEAKED TITLE FROM A"; a mismatched returned agent_id rendered.

$ npx vitest run src/tests/blackbox/terminal-hooks.blackbox.ts src/tests/blackbox/use-ancestors.blackbox.ts
Test Files  2 failed (2)
Tests       2 failed | 39 passed (41)
Observed: delayed A refresh and ancestor fallback mutated B-owned state.
```

After the fix and adversarial sibling pass:

```text
$ npx vitest run src/tests/blackbox/agent-isolation.blackbox.tsx src/tests/blackbox/browser-cursor-overlay.blackbox.tsx src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts src/tests/blackbox/hooks-lib-realtime-handlers.blackbox.ts src/tests/blackbox/hooks-lib-animation-tree.blackbox.ts src/tests/blackbox/use-message-filtering.blackbox.ts src/tests/blackbox/terminal-hooks.blackbox.ts src/tests/blackbox/use-ancestors.blackbox.ts
Test Files  8 passed (8)
Tests       133 passed (133)

$ npx vitest run src/tests/blackbox/terminal-hooks.blackbox.ts src/tests/blackbox/use-ancestors.blackbox.ts
Test Files  2 passed (2)
Tests       40 passed (40)
```

## Human feedback

The human reported: "im still getting leaks from one agent-id to another's page
on the fe or mac-app" and insisted: "NUKE THAT POSSIBILITY FROM EVERY HAPPENING,
CEMENT, AND /deploy".

## Reusable lesson

Bind every asynchronous agent-view state write to the live selected-agent identity and recheck it inside the final state updater.
