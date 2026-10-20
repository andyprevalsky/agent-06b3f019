---
id: 2026-10-09-live-view-derived-from-lagging-transcript-not-session-binding
date: 2026-10-09
title: The live view embedded the transcript's last browser_url, so every session swap or provider expiry showed a closed Kernel/Steel session
surface: cross
component: browser-session-binding
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end BrowserSession rebind/close paths (challengeRecoveryPromote, Kernel recreate, Steel resume, Browser Use replace, sessionPersist reclaim) changed the task's provider-session binding and released the old session without announcing it, so the front-end live view could only follow the lagging transcript browser_url and had no liveness signal
symptoms:
  - sometimes kernel or a browser will not stream the browser UI because the session closed
  - live view shows a closed or expired Steel/Kernel session after User Assistance Received
  - browser panel goes dead during Searching browser configurations and recovers only at Browser challenge recovered
  - iframe src stays on connect.steel.dev/v1/sessions/<old>/player after Task moved to Steel session <new>
  - auth assistance live view shows an expired Steel session before refresh-session completes
tags:
  - live-view
  - browser-session
  - kernel
  - steel
  - challenge-recovery
  - auth-assistance
  - front-end
  - source-of-truth
sources:
  - agent 8b4d4592-c5da-4889-8a01-52824db125d1
repro: front-end/src/tests/blackbox/browser-live-view-binding.blackbox.tsx
status: fixed
---

## Problem

Prod agent 8b4d4592 (DoorDash refund, browser task e264ec23) moved across four
provider sessions: Kernel `8ncskyVhBqSj` → Steel `f26ee1ab` (challenge recovery,
2026-10-08 18:27:46) → Steel `201b22cb` → Kernel `pmHw1BNYtFaS`. The live view
showed a closed session in two windows on 2026-10-09:

- Render logged `Created new Steel session: 201b22cb…` at 20:32:09 and
  `Task moved to Steel session 201b22cb…` at 20:32:18 (the auth-assistance
  refresh rebinding the row). After `User Assistance Received` (20:34:10) the
  panel fell back to the transcript's `f26ee1ab` player, expired about 26 hours
  earlier, until `session_init` posted `201b22cb` at 20:34:25.
- When the auth request was opened (20:32:07) its handoff named `f26ee1ab`,
  which Steel had ended about 26 hours earlier, until the refresh moved the task
  to `201b22cb` at 20:32:18. The row was ACTIVE throughout; only provider health
  knew the session was gone.
- Challenge recovery created Kernel `qzsodw10re6xto2hd8vcjxps` at 20:36:20 and
  promoted it, releasing `201b22cb`. The transcript carried `201b22cb` until
  `Browser challenge recovered` posted `pmHw1BNYtFaS` at 20:36:59.

The prod BrowserSession row (id = task id) pointed at the live session the
whole time; the transcript did not.

## Diagnosis

`computeActiveBrowserPanels` (front-end/src/features/terminal/hooks/derivations.ts)
selects the latest transcript `browser_url`, and BrowserStatusBar embedded it.
The transcript is a lagging event copy of the binding. Every rebind path updates
the task's row and then releases the previous provider session before the worker
learns the new URL: `challengeRecoveryPromote.ts` promote (row update, then
`releaseKernel/Steel/BrowserUse`, then the HTTP response), `kernel.ts`
recreate/rotate, `steel/sessionResume.ts`, `sessionPersist.ts` reclaim, and the
auth-assistance refresh (via resume). None of them broadcasts or writes a
message; the worker's first message with the new URL comes after reconnect,
storage restore and verification (`handler.py` reassigns `browser_url` only after
the promote response). The FE therefore had a guaranteed window, of unbounded
length when the worker is idle, in which its only URL source named a session
the backend had already closed.

Why it was possible: the backend changed the binding without telling anyone.
Rebinds and closes write the row but neither broadcast nor create a message, so
the live view had no current source; it consumed the transcript, which cannot
be current, and had no notion of liveness. An ACTIVE row can also outlive its
provider session (the 26-hour handoff), which no transcript or row status
shows. Pinned overrides made it worse: a take-control or resume URL was stored
once and never followed a later swap.

Relative of `2026-07-13-browser-live-view-url-selected-by-delivery-order`: that
fix ordered transcript URLs correctly but kept the transcript as the source, so
it could not cover swaps the transcript has not yet announced.

Repro: `cd front-end && npx vitest run src/tests/blackbox/browser-live-view-binding.blackbox.tsx`.
On the buggy FE (only the passive binding store added so the file imports)
7/7 failed with the incident's URLs: `Expected …201b22cb… Received …f26ee1ab…`
(auth completion), `Expected …pmHw1BNYtFaS… Received …201b22cb…` (promote
broadcast, take control), `Unable to find [data-testid="live-view-loading"]`
(ended handoff), `expected <iframe> to be null` (closed binding). After the fix
7/7 pass. Backend ordering: `browser-challenge-recovery.blackbox.ts` fails with
`promote never announced the winner` when the promote announcement is removed.

## Solution

The backend now announces the binding and the live view follows it:

- `announceBrowserSessionBinding` reads the task's row and broadcasts
  `BROWSER_SESSION {taskId, sessionId, debugUrl, status, live, asOf}` on the
  existing per-agent `agent:<id>` channel. It is called after every rebind
  commits and before the old provider session is released (challenge promote,
  Kernel recreate/rotate, Steel resume/rotate, Browser Use replace,
  `sessionPersist` reclaim/reactivate), and after pause/close.
- `GET /api/browser-session/task/:taskId/live-view` (owner-checked, no lease
  side effects) returns the same shape, confirming ACTIVE rows against provider
  health, so an expired session reports `live: false` (`null` when health is
  unknown).
- The FE keeps the newest binding per task by server `asOf`
  (`lib/browserSessionBindings.ts`), fed by the broadcast and by the GET on
  mount, transcript change and focus/visibility; there is no interval poll.
  `useBrowserSessionBinding` serves the bound URL; auth handoff shows the
  interactive bound URL once a binding is known (every handoff is
  `same_steel_session_live_view`); user control shows the interactive bound URL;
  resume re-reads the binding instead of pinning a URL. `live=false` replaces
  the iframe with `LiveViewLoading`, which also covers each new URL until its
  iframe loads and sits under Take Control / Start Agent.
- Deleted the unreachable `BrowserViewPanel` / `browser-view-panel/` tree, a
  second transcript-only live-view path with no production importer.

Adversarial review rejected a first version that polled the control endpoint
every 5 s (per visible card, including stacked minimized cards, with a lease
write per read and a ≤5 s gap) as the wrong layer under rule 28; the push design
replaced it.

10k-agent behavior: one row read and one broadcast per rebind/close on that
agent's own channel (rare events, no fan-in); one GET per visible panel on mount,
focus or transcript change, each with one provider health call; zero idle load.
Residual: a provider-side expiry while a viewer keeps the tab focused and no
rebind happens is only detected on the next focus or transcript change.

Golden reference: no reference harness embeds a provider live view (searched
`claude-code-src/`, `openclaw/`, `hermes-agent/`, `codex/`, `prime-agent/` for
liveView/debugUrl). The closest analog, hermes-agent's desktop app, renders its
"Reconnecting…" state from the authoritative gateway connection
(`hermes-agent/apps/desktop/src/app/chat/composer/hooks/use-composer-placeholder.ts:58`)
and re-dials through one owner (`hermes-agent/apps/desktop/src/store/gateway-reconnect.ts:32`).
The fix converges on that: render from the authoritative binding, pushed on
change, and show a connecting state rather than a dead stream.

## Human feedback

None recorded.

## Reusable lesson

Bind a live view to the backend's authoritative resource binding, not to the
last URL an event log happened to announce — the event log lags every swap.


### 2026-10-18 recurrence: failed Steel writer handoff omitted the binding announcement

Exact CDF `cdf0aeda05c62d90ab825340ee955e6ee97ee68d` review cycle 2
comment `4305395318` exposed a missing failure branch of the same authoritative
binding publication contract. `finishSteelProfileWriter` commits the exact
writer to PAUSED, and an unacknowledged native release can then commit ERROR
(or retain PAUSED when native released evidence is available). The helper
rethrows the release error. Its caller invoked that helper before its outer
try, with `writerReleased` still false, so the failure never reached the
existing announcement. A subscriber could retain the old ACTIVE binding.
This is a local, reproduced publication omission, not evidence that it caused
the concurrent minted-SMS benchmark failure.

The repair is at the failure-state mutation owner, not a new recovery path:
retain the result of its existing ownership-fenced, exact-binding updateMany;
only when that CAS changes one row, call the existing
`announceBrowserSessionBinding` before rethrowing the identical release error.
The announcement reads the persisted row and is already best effort. Lost
ownership and a concurrent close or rebound do not satisfy the CAS and do not
produce this notification. Native inspection/release, lifecycle ownership,
retry bounds, task/session identities, and the caller are unchanged. This
extends the prior push contract to its missed error path; it does not add a
poll, status, provider retry, or transcript workaround.

The existing registered
`testWritableSteelProfileHandoffRetainsRecoveryCustody` owner was extended with
real recreateSession, lifecycle and mutation code. External database/native
edges remain in memory; the actual notification builder and broadcast queue
run through a mocked fetch transport, and socket/DNS access is denied before
imports. Two release failures require one exact persisted ERROR/PAUSED binding
notification, the original exception object, and no replacement creation.
Concurrent CLOSED and rebound rows require no overwrite or notification. All
64 original assertion-call text multiplicities remain; the owner now has 74.
The same permanent test bytes on unchanged CDF fail with
`committed writer failure omitted binding announcement`; the private candidate
passes the full existing owner and its controls, normally joined, with the
owner's unexpected external-request counter still zero.

The selected owning command uses the verification workspace's installed tsx
loader to execute only the exported registered owner in a private physical
CDF source copy, with its pre-import network denial and secretless test
configuration. It does not execute the full registrar, backend coverage,
provider smoke, or a native benchmark. The initial loader path incorrectly
assumed tsx was installed below back-end/node_modules; that setup failure
occurred before test entry and is retained separately. The corrected same-owner
baseline and candidate commands and logs are bound in
`.context/auth-deploy/repair-next-primary/steel-writer-announcement-cdf-rca/final-proof.json`
(SHA256 `1c91a791b53d67826d60e25394613906ca46d2b433d1744dcd4507923ef6f890`).
Runtime patch SHA256 is
`816353d2bdabd8fe9e11bf25fa6d5cefed65d1133777dea3ba74a620fad0ca24`;
regression patch SHA256 is
`8a8f7e29da2f0a1465f86fa146a2e849806b833d39dce8b0c63fce66dbbec9bb`.

Two canonical searches were run against all 942 CDF cases using
`finishSteelProfileWriter announcement release ERROR` and
`BROWSER_SESSION stale binding PAUSED source release`, followed by the exact
symbol search. This case and the October 14 writable-profile handoff case were
read in full, including Solution and Human feedback. The latter is a related
ownership repair; this recurrence appends here because the violated contract
is publication after an authoritative binding state change. These searches
followed the initial review-driven source triage and owning reproduction,
rather than preceding the hypothesis; that ordering gap is retained, not
backdated. No new human feedback was recorded. Central composition, canonical
archive validation, full gates, and deployment remain with ROOT; the private
patch has not been adopted or pushed.
