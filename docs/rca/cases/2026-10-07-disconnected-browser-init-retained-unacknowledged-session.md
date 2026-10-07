---
id: 2026-10-07-disconnected-browser-init-retained-unacknowledged-session
date: 2026-10-07
title: Initial browser HTTP disconnect retained an unacknowledged allocated session
surface: back-end
component: browser-session-initialization-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: POST /api/browser-session/init returned an allocated session after its unfinished response had closed without releasing that exact session
symptoms:
  - disconnected init retained an unacknowledged session
  - init transport timeout
  - ACTIVE browser session after initial HTTP response disconnect
tags:
  - browser-session
  - transport-disconnect
  - cancellation
  - provider-ownership
  - exact-cleanup
sources:
  - PR #1440 review comment 4212280781, formal review 5448706575
  - commit c968b967fdd5689e9288537f82ab426ff95340da
  - fleet run 20261007-185005-80376, related original Minted preparation timeline only
repro: back-end/src/tests/blackbox/browser-session.blackbox.ts --init-disconnect-only; frozen native loopback HTTP RED/GREEN in .context/browser-init-disconnect-rca/{red-frozen,green-frozen}.log
status: mitigated
---

## Problem

The review's claim that ordinary caller cancellation cancels `owned_init` does
not describe current code: the worker shields and joins that same bounded HTTP
operation before closing its returned owner. A separate transport timeout or
broken connection can still close the HTTP response while the backend continues
initialization. The route had no disconnect release; a later successful init
could leave its persisted session ACTIVE without delivering its handle.

This is a locally reproduced API lifecycle boundary, not proof of another
production leak or a repaired benchmark. Original Control9 remains fully
released, failed and worth zero credit. Its Minted benchmark status is FAILED
while the preserved executor snapshot is ACTIVE; its original durable bundle
remains missing and immutable.

## Diagnosis

Critical path: worker's same initial POST → Express init route → provider
allocation and persistence → credential preparation → returned exact session →
HTTP response. The backend service releases an allocated session when credential
preparation throws. A disconnected response does not make preparation throw.
The first bad boundary was therefore successful init after response loss, not
the worker's ordinary cancellation join or credential-error cleanup.

Terminal release already retries ACTIVE, PAUSED and ERROR session rows for
COMPLETED, FAILED, OUT_OF_CREDITS and COST_LIMIT_REACHED agents. It intentionally
does not select ACTIVE/PAUSED agents. A terminal fallback cannot immediately
release an unacknowledged allocation while its agent remains nonterminal.
The provider's existing close marks ERROR and retains `closedAt=null` on remote
release failure, preserving that fallback rather than claiming billing stopped.

The permanent owning browser-session blackbox loads the actual production router
with only auth/service/provider boundaries replaced by local fixtures. Real
Express and loopback HTTP perform the request and socket destruction. The
fixture allocates an exact session and holds preparation; the client destroys
its socket, the server observes native response close, and the same operation
settles. On unchanged c968 route code the command below exits 1 with
`disconnected init retained an unacknowledged session`: no exact close was called.
The identical frozen command and fixture pass after the fix.

```bash
cd back-end
PATH=/Users/andyprevalsky/.nvm/versions/node/v22.13.0/bin:$PATH \
  node --import tsx src/tests/blackbox/browser-session.blackbox.ts --init-disconnect-only
```

The five cases cover disconnect during preparation, disconnect before allocation
finishes, successful response completion, native-close failure retaining ERROR,
and initialization error with no returned owner. Every case preserves a foreign
session, and positive cleanup occurs exactly once for the returned session.
The production provider and database are not contacted by this reproduction;
its ERROR assertion represents the unchanged native close contract, not a new
live provider proof.

Archive searches used `browser init disconnect timeout orphan allocation` and
`preallocated BrowserSession create retry`. The September 7 preallocated-ID case
already owns reclaim and superseded-session release; it does not own response
disconnect. The August 19 terminal-release case is an existing fallback. The
October 7 Minted caller-cancellation case is a related boundary, not the same
failure after its join fix. Its original worker cancellation at 19:17:21.410508
and backend response at 19:17:32.016 establish preparation overlap, not a new
transport-timeout attribution. No original receipt is rewritten.

## Solution

The init HTTP handler retains ownership of the same awaited initialization. A
response close before `writableFinished` records disconnection; when the exact
session returns, it is closed with `pause=false` instead of sending JSON to the
lost caller. The same single close promise owns a later close event after init
returns. A normally completed response remains active. Request-body completion
is not mistaken for response loss, no creation is replayed, and no foreign
session inventory is scanned. A close error is logged and the existing terminal
reconciler remains the fallback; no terminal status or receipt is forged.

The handler is extracted into `routes.init.ts` following the existing route
module pattern because the added ownership code exceeded the route file's
300-line lint limit. The service, provider, worker cancellation join, transport
bounds, model messages, tasks, evaluator and archive rules are unchanged. This
introduces no phase/admission registry or database schema. Each request uses
constant local state and at most one additional exact close on interruption.

Reference comparison: OpenClaw `src/gateway/watch-node-http.ts:202` distinguishes
response close from completion with `!res.writableFinished`, and
`src/gateway/mcp-http.ts:135` checks incomplete request/response lifecycle.
Claude Code `src/upstreamproxy/relay.ts:268` releases connection-owned resources
on socket close. Hermes `gateway/browser_control_broker.py:302` preserves exact
owner identity on disconnect, but its reconnectable controller is not a rented
session allocation analog. These references were read from existing local
snapshots. The Codex snapshot was absent in the checked workspaces; no Codex
analog is asserted.

The existing backend runner discovers `browser-session.blackbox.ts`, which calls
these cases on every normal invocation before its existing API checks. The
focused flag only omits unrelated live-stack checks for isolated diagnosis;
it is not a replacement for `/deploy`'s normal Step 4a backend coverage/blackbox
gate. Focused owning RED/GREEN, backend type checking, selected-file lint and
case registration are recorded in the private sidecar directory. Mitigation is
staged in an isolated c968 worktree for independent review and the coordinated
deploy batch; no production mutation or paid call occurred. No end-to-end
original Minted evidence recovery or fresh control acceptance is claimed.

## Human feedback

The parent required verification of the reviewer premise, an actual failing
path before code changes, exact backend disconnect cleanup with terminal retry
preserved, normal-success and foreign-no-action inverses, unchanged owning
RED/GREEN, independent review and an archive record. The publisher/source-table
agent owns its separate batch. D and original control sources, evidence,
results, secrets and Freedom must remain untouched.

## Reusable lesson

An HTTP allocation owner must retain its exact late-returned resource when an
unfinished response loses its caller, while treating normal response completion
and durable failed-release retry as different lifecycle events.
