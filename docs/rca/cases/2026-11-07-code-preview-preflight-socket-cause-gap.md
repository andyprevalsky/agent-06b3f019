---
id: 2026-11-07-code-preview-preflight-socket-cause-gap
date: 2026-11-07
title: Code preview preflight GET lacks original socket-cause capture
surface: harness
component: code-preview-blackbox
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Original socket cause unproven; candidate is synchronous makeRoseFrontEndHome before the pre-preview GET
symptoms:
  - "TypeError: fetch failed"
  - "code-preview.blackbox.ts:322:18"
  - "ERR_TEST_FAILURE"
tags:
  - code-preview
  - socket
  - fixture
  - event-loop
sources:
  - PR #1708
  - commit 60ca0ff528360e8e54198cec54c00a11fab4a50e
  - plan:.context/rca-browser-4f77/code-preview-rca-1938/child/RCA-draft.md
repro: back-end/src/tests/blackbox/code-preview.blackbox.ts
status: open
---

## Problem

Native backend code-preview failed after 14,516 ms; subtest 11 threw fetch failed before preview startup. Its original failure, detailed logs, hashes and commands remain in the private RCA packet referenced above. Full backend acceptance remains pending with the parent.

## Diagnosis

The exact request is the pre-preview GET at line 322. The server logs no matching request after the last prior handoff at 19:34:59.396Z and before the next publish at 19:35:07.310Z. The client was preparing a copied front-end in that interval; the exact task UUID and nested transport cause were not captured. Gate: UNKNOWN.

A controlled local native Node transport replay runs the unchanged owning fixture helper with 6,500 ms I/O latency. It fails with UND_ERR_SOCKET: the error's local port equals a server socket closed during the synchronous copy, and no GET reaches its handler. Making preparation asynchronous passes the identical request and assertions five consecutive times. The natural undelayed original-helper replay passed, so the historical occurrence still has an open reproduction/cause gap. A controlled mechanism is not proof of the missing historical socket event.

The fixture, caller, observer, status/service, server and runner are byte-identical at original 0d3a03ae0da476027bfceaf35724c75744062119, main b365bf8bd69346f872e5e2cb7218872155ca294d, frozen root 60ca0ff528360e8e54198cec54c00a11fab4a50e and the owning worker. This establishes the controlled defect predates the change; it does not exclude indirect timing changes in the original incident.

## Solution

The private candidate now registers an event-driven fixture/socket regression in the existing code-preview blackbox. The unchanged final child fails on the original synchronous fixture and passes five consecutive times with awaited filesystem operations. Through the normal `bash scripts/run-blackbox-tests.sh code-preview` entrypoint, the original 16 tests pass before the repair, the registered regression adds one native UND_ERR_SOCKET failure, and the repaired full domain passes all 17 tests. The final complete private-closure run exits 0 in 43.411778420 seconds, with 21.453 seconds inside the domain and HMR latencies 2037, 295, 204, 171 and 174 ms against the unchanged 3000 ms target.

The four-file source-proposal-v2.patch also extracts the test HTTP helper to retain the existing lint limit and log selected transport causes before rethrowing. All changed files pass ESLint/Prettier and focused strict TypeScript checks pass. No retries, existing deadlines, assertion values or test scope were weakened. The child used only the authorized scratch database, verified native cleanup, then dropped that database with zero active sessions. Only private source changed; parent integration and the final whole 252-entry gate remain pending. Original attribution stays UNKNOWN because the complete pre-fix domain with capture passed and the historical socket cause was not retained. See RCA-continuation.md and result-continuation.json for exact commands, source/environment hashes, every native run and limitations. Test-only changes add no production work at 10k agents. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user required a bounded independent investigation and private patches only, prohibited shared stack/database/Git/source changes and paid work, preserved Treasury as a separate exception, and reserved final review, stabilization and deployment for the parent. No recursive child is authorized merely to satisfy the delegation rule.

## Reusable lesson

Keep fixture I/O asynchronous while HTTP clients own pooled connections, and capture nested transport causes before attributing a pre-handler fetch failure.
