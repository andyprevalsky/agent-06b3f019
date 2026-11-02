---
id: 2026-10-28-pending-realtime-join-outlived-attention-owner
date: 2026-10-28
title: A pending attention-channel join outlived unmount and logged during Vitest teardown
surface: front-end
component: attention-realtime-subscription
classification: our-bug
problem_class: other
first_bad_boundary: useAttentionRequests could not cancel subscribeToChannel before SUBSCRIBED assigned channelRef
symptoms:
  - 'EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending'
  - 'User attention channel (user:test-user) status: TIMED_OUT'
  - 'Failed to subscribe to attention requests: Subscription timed out for user:test-user: unknown'
tags:
  - supabase
  - realtime
  - teardown
  - async-cancellation
  - vitest
sources:
  - PR #1627
  - commit 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
  - plan:/var/tmp/deploy-1627/rca/frontend-teardown/pending-join-before.log
  - plan:/var/tmp/deploy-1627/rca/frontend-teardown/pending-join-after.log
repro: front-end/src/tests/blackbox/app-wiring.blackbox.tsx
status: fixed
---

## Problem

The front-end coverage lane passed 246 files and 4009 tests, and exceeded all
coverage thresholds, but failed with three unhandled console RPC rejections
during environment teardown. The original lane log at
`.context/deploy-pipeline/logs/frontend-coverage-blackbox.log` showed a stale
`user:test-user` join timing out during a later `/download` route test. A local
single-file instrumented run independently captured the same status log,
disconnect error, and rejected-subscription error during a later `/terminal`
test. HTTP requests had already settled; the lingering resource was a Phoenix
join timeout.

Archive searches for `EnvironmentTeardownError onUserConsoleLog`,
`vitest console async teardown`, and `Supabase join unmount subscription` did
not identify a prior case for this ownership gap. This is a novel case, not an
established recurrence.

## Diagnosis

Critical path: route render -> attention hook effect -> async subscription ->
pending Supabase/Phoenix join -> owner unmount -> socket fixture disposal ->
join timeout -> three console messages -> Vitest RPC shutdown rejection.

The hook assigned `channelRef` only after `subscribeToAttentionRequests`
resolved with SUBSCRIBED. An unmount before that point set `cancelled` but had
no channel reference to unsubscribe. The subscription Promise exposed no way
to cancel the acquired, still-joining resource. Silencing the mock socket did
not cancel Phoenix's join timeout, so its callbacks survived the owner. The
deepest owned cause is uncancellable asynchronous resource acquisition, not
an overly short timeout or a reason to ignore unhandled errors.

The permanent regression drops WebSocket acknowledgements, verifies the
channel is joining, unmounts the hook, and advances fake time through the
unchanged library deadline. Before the fix it fails with exactly three late
messages (`TIMED_OUT`, disconnect error, and failed subscription). Its fixture
and assertions are unchanged after the fix.

Exact local command (after sourcing `/var/tmp/deploy-env.sh` from the integration
worktree):

`node /home/boxes/rose/.claude/worktrees/agent-a0f677519b4ea0db3/node_modules/vitest/vitest.mjs run --root /home/boxes/rose/.claude/worktrees/agent-a0f677519b4ea0db3/front-end src/tests/blackbox/app-wiring.blackbox.tsx --maxWorkers=1 -t 'cancels an attention join'`

Before: `AssertionError: expected [ …(3) ] to deeply equal []`.
After: `Tests 1 passed | 24 skipped (25)` and exit 0. The skipped cases are
the explicit single-test diagnostic filter; the full original file also
passes all 25 tests without a filter.

## Solution

Add an optional AbortSignal to the common channel subscription boundary and
forward it through the attention subscription. Check cancellation before and
after the auth await. On an in-flight abort, remove the channel immediately,
cancel its Phoenix join timer, and reject with an identifiable AbortError.
Suppress status callbacks only for that intentional abort. The attention
effect aborts its pending join on teardown, keeps normal connected-channel
cleanup, and ignores only its own cancellation. Live subscription errors
still log, reject, and follow the existing reconnect behavior.

Deletion would remove the awaited-subscription contract used by callers, so
the fix extends that common ownership boundary instead of changing readiness
semantics. The original-file regression and a channel-empty afterEach guard
prevent recurrence. `front-end/vitest.config.ts` includes the file and deploy
Step 4b runs it via `npm run test:coverage`; no new runner or weakened threshold
was introduced. Existing realtime transport tests exercise normal joins,
leaves, resubscription, and real CHANNEL_ERROR propagation.

The additional permanent `attention-requests-unmount.blackbox.ts` file covers
unmount before auth completes, unmount with an unanswered join, and ordinary
cleanup after a successful subscription. All three pass, including assertions
against late disconnect logging and remaining registered channels.

A final full-file check also exposed a cold-module fixture race: `/terminal`
still showed the Suspense fallback after the five-second UI assertion budget,
while Vite was transforming its lazy module. The shared route-render fixture
now awaits `vi.dynamicImportSettled()` inside `act` before beginning the
existing UI assertions. No assertion or timeout changed. The same full-file
command failed with one lazy-route failure before this fixture change and
passed all 25 cases afterward. The pending-join regression body is unchanged.

An intermediate implementation used DOMException plus `instanceof Error` to
detect its own cancellation. A failing local check exposed the jsdom/Node
realm mismatch. The final implementation uses a named Error and an
object/name guard, preserving explicit cancellation without masking real
failures.

Golden reference: not applicable (no approval-gated hunk).
Independent read-only review: APPROVE, no blocking findings, by thread
`ph7f2zz6y5nj4jv5sbq80td7zn8h4bj3`.

This draft is for the deploy coordinator to install into `docs/rca/cases/`,
reindex, and validate. The full multi-file coverage lane remains a coordinator
integration gate; the author was restricted to focused domains. No backend,
worker, or stack restart is needed. Runtime cancellation takes effect with
the next frontend build and page refresh.

## Human feedback

The user required an observed local FAIL->PASS, no timeout increases, no
skips or weakened assertions, regression coverage in a deploy-run suite,
and scoped edits in the integration worktree. Ownership moved from Codex
author to Claude author/Codex reviewer, then back to Codex sole author when
the Claude session limit returned. Source changes stayed within the cluster.

## Reusable lesson

Expose cancellation when asynchronous resource acquisition starts, before
the resource's ready Promise resolves and transfers its handle to the owner.
