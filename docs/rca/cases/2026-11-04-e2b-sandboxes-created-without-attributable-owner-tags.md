---
id: 2026-11-04-e2b-sandboxes-created-without-attributable-owner-tags
date: 2026-11-04
title: E2B sandboxes carried no owner metadata and dropped stacks never killed theirs, leaving ~2000 unattributable paused sandboxes
surface: back-end
component: e2b-sandbox-attribution
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/e2bSandboxCreate.ts createSandboxAttempts tagged sandboxes only with createRequestId; scripts/run.sh dropped an owned database without killing the sandboxes it recorded
symptoms:
  - E2B paused sandboxes metadata only {createRequestId}
  - paused=2001 running=0 orphaned E2B sandboxes
  - local bench stack teardown leaves paused E2B sandboxes with no DB row
  - cannot tell which deployment or database owns an E2B sandbox
tags:
  - e2b
  - sandbox-leak
  - attribution
  - teardown
  - code-sessions
sources:
  - commit d420861176
repro: back-end/src/tests/blackbox/code-sessions-sandbox-attribution.cases.ts
status: fixed
---

## Problem

The parent's read-only E2B inventory of the shared account key (2026-11-04,
about 23:00Z) found `paused=2001` (possibly capped by pagination) and
`running=0`. 1373 were older than 7 days. Every one carried only
`{createRequestId}` as metadata. Prod has about 228 `CodeSession` rows, so nearly
all are orphans, and none can be safely reaped because ownership cannot be
proven. A concrete source was observed live: an isolated `scripts/run-bench --local`
stack drops its database on teardown (`run.sh` `DB_OWNED_BY_US`) without
retiring its persistent code sessions, which orphaned the 7 sandboxes its runs
created.

## Diagnosis

`createSandboxAttempts` (e2bSandboxCreate.ts at base 28a7bfc99) set
`metadata: {...options.metadata, createRequestId}`, and no caller passed owner
metadata. `run.sh cleanup()` dropped an owned container or system database
without touching E2B. E2B keeps paused sandboxes indefinitely (docs: no
TTL/auto-delete), so every leak is permanent. Billing docs: compute stops on
pause, the concurrency limit counts sandboxes "running at the same time" (so
paused ones should not count, by inference), paused retention is "Unlimited",
and storage billing for paused sandboxes is not stated.

Repro (buggy code): `cd back-end && bash scripts/run-blackbox-tests.sh code-sessions` →
`not ok 29 - every E2B sandbox is created with attributable metadata` with
`roseOrigin tag missing: {"createRequestId":"…"}`; `not ok 30 - stack teardown …
the reaper kills only attributable orphans` with `sandboxes need a stack identity`.

## Solution

- **Tag at create.** Every `createSandboxWithRetry` sandbox gets `roseOrigin`
  (the Render service, else the host) and `roseStack`. The stack is the origin
  plus a hash of the DB host/port/name, or an explicit `ROSE_SANDBOX_STACK_ID`.
  Code-session sandboxes also get `codeSessionId`, `ownerAgentId`, `rootAgentId`
  and `userId`. No credentials are tagged.
- **Stack teardown.** `back-end/scripts/kill-stack-sandboxes.ts`
  (`killStackSandboxes`) kills every sandbox tagged with this stack, after a
  client-side re-check of the tag. `run.sh cleanup()` runs it before dropping a
  database it owns. The blackbox runner sets `ROSE_SANDBOX_STACK_ID=blackbox:$RUN_ID`
  and runs it on exit. The script refuses a non-local `DATABASE_URL` unless the
  stack id is explicit.
- **Orphan reaper.** `reapOrphanedCodeSandboxes` runs every 15 minutes in
  production under a ToolSideEffect lease (one replica). It lists only this
  stack's tagged sandboxes (at most 200 per tick, 100 per page) and does one
  `id IN` read per tick. It kills a sandbox only when its `codeSessionId` row is
  gone, RETIRED, or names another sandbox while this one has been paused for
  over 1 h. Untagged sandboxes, including the existing 2001, are never touched.
- Live check on real E2B: a tagged base sandbox was killed by the teardown
  script (`killed 1`), and a rerun killed 0.

10k agents: tags are free. Listing is filtered server-side by tag and bounded
per tick; a backlog drains over ticks. There is no per-live-session work.

Not done here: the 2001 existing untagged sandboxes need a one-time human
decision (they cannot be attributed). One-shot (non-session) sandboxes are
tagged with the stack but not the task, so the reaper keeps them; they are
killed on close.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Tag every rented external resource at creation with the deployment and database that own it, and make each stack's teardown release exactly its own tag before its records disappear.
