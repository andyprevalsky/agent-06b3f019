---
id: 2026-11-05-tilion-missing-session-health-not-terminal
date: 2026-11-05
title: Tilion missing native session threw before logical browser reconciliation
surface: back-end
component: tilion-health
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: getTilionSessionHealth threw TilionApiError for a confirmed missing native rather than returning terminal health
symptoms:
  - "Tilion HTTP 404 on GET /v1/session/sess_993d708b86234f3b950c7bcb7058436f/status: No such session"
  - "Browser session init failed after 5 transient-proxy retries"
tags:
  - tilion
  - browser-session
  - health
  - logical-browser
  - missing-session
sources:
  - agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb
  - commit 67998442e44f8cbba942040d9cbeeaea84eb0cb0
  - PR #1866 (shipped; merge 7577a6573682179b3715fa25e9433e27cf9e24e6)
repro: back-end/src/tests/blackbox/browser-provider.tilion-wiring.support.ts
status: open
---

## Problem

Seven browser launches on November 5 each exhausted five init attempts against the same absent native. Worker logs show the first at 22:19:03Z and last failure at 22:54:07Z. A read-only DB transaction found the logical row still ACTIVE with that native, checkpointRevision=0 and no checkpointRef. Saved account credentials were not modified.

## Diagnosis

Path: spawn_browser_agent -> POST browser-session/init -> initSession -> task-info health / resume owner -> Tilion GET status -> logical reconciliation. The status adapter let a 404 escape, so task-info could only report an unknown health failure and resume threw before recordEndedLogicalBrowser. Kernel retains deleted records; Tilion removes them. The shared lifecycle requires explicit terminal health, not exceptions or unknown health. This is an adapter contract error, not a transient proxy issue.

Executed regression on baseline production code: from back-end, `../node_modules/.bin/tsx -e "import {assertStoredTilionRowDispatchesToTilion as run} from './src/tests/blackbox/browser-provider.tilion-wiring.support'; run().then(()=>console.log('PASS stored Tilion health')).catch(e=>{console.error(e);process.exitCode=1})"`. It exited 1 with `TilionApiError: Tilion HTTP 404 ... No such session`. The identical command after the fix exited 0. The test requires terminal health for 404/410 and preserves thrown 401/500. Original outputs: `.context/rca-7a2ead9f/health-before.txt` and `health-after.txt`.

Archive searches: `Tilion No such session transient-proxy retries`, `browser session stale deleted session reuse cleanup failed`, and `Tilion health 404 ended missing session`. Relative of the Tilion pause/checkpoint cases; no matching cause found.

## Solution

Translate only typed status-endpoint 404/410 into deleted health with the exact native ID, zero remaining lifetime and unknown timestamps. All other errors retain their original type and details. Existing shared lifecycle reconciliation then sees confirmed end. This also covers native expiry on auth-assistance/resume and other health consumers without special-casing an agent or site. No extra network calls, allocations, retries or 10k-agent polling are introduced.

Golden reference: not applicable (provider response adaptation; no approval-gated hunk). All three deploy approval guards pass without override. The case remains open pending broader validation, independent review and deployment. Managed investigator/reviewer creation returned `delegation_service_unavailable`, including a fresh-key retry; no delegated review ran.

Important limit: this does NOT reconstruct the original root browser's missing private checkpoint. Its earlier failed checkpoint and provider expiry lost the native state. The existing saved-checkpoint guard remains intact; the fix must not silently resume from an empty baseline or claim continuity.
## Human feedback

The user requested `/rca` for agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb and asked to fix all its browser issues. No subsequent corrections recorded.

## Reusable lesson

Represent confirmed provider absence as terminal health at the adapter boundary while preserving unknown health failures and private-state continuity guards.
