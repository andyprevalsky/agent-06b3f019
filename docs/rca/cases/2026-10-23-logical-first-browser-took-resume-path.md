---
id: 2026-10-23-logical-first-browser-took-resume-path
date: 2026-10-23
title: An agent's first logical browser took the resume path, dropping its provider profile, saved realm credentials and injection metadata
surface: back-end
component: browser-session-init
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/browser-session/service.ts initSession routed a never-materialized logical row to resumeOwnedBrowserSession, and prepareSessionCredentials returned before injectUserData for every logical row
symptoms:
  - "existing-browser-session-outcome failed: Site never recorded session:resumed in the expected order"
  - "stale-session-password-outcome failed: Site never recorded session:rejected:expired_session in the expected order"
  - Expected isolated browser session metadata was not observed
  - "Kernel session profile resolved profileSource=challenge_candidate_ephemeral for a new task browser"
tags:
  - browser
  - logical-browser
  - saved-session
  - credentials
  - benchmark
sources:
  - commit c398d2960 (persist one lazy browser per GP and Home baseline)
  - fleet run original600-1792711291636839185 (HEAD 620cb2e10)
repro: back-end/src/tests/blackbox/browser-session-logical-first-init.fixture.ts
status: fixed
---

## Problem

The attempt-3 `/benchmark full` run on feat/rose-user-ui (HEAD 620cb2e10, synced
with main) failed six browser jobs that passed their last three runs on main:
browser-auth-existing-browser-session ×2 (the agent signed in by password instead
of resuming the saved session), browser-auth-stale-session-password ×2 (the
expired saved session was never presented), and browser-biometrics-webdecoy ×2
("Expected isolated browser session metadata was not observed"). Guest backend
logs showed that every agent's first `/api/browser-session/init` logged
`[BrowserSessionResume] Resuming browser task` and resolved the Kernel profile as
`challenge_candidate_ephemeral`. The run records' `browser_session_metadata`
carried only provider, proxy and profile fields, with no `auth_source`,
`cookies_injected` or storage counts. Locally, the unchanged
`scripts/run-bench --local browser-auth-existing-browser-session` failed with the
same reason on 620cb2e10.

## Diagnosis

Commit c398d2960 gave every general-purpose agent a lazily created logical
browser row (`logicalOwnerKey agent:<id>`, `sessionId NULL`, empty Home baseline)
and made `initSession` resume that row. The resume path is built for logical
browsers that hold private checkpoint state. It omits the provider profile
(`omitProfile` in recreateKernelSession), skips `injectUserData`, and returns
resume-shaped metadata. `prepareSessionCredentials` also returned early for any
logical row. A never-materialized row has no checkpoint, and its Home baseline is
`EMPTY_BROWSER_BASELINE`. It therefore started with no profile, no saved realm
credentials (cookie bundle) and no injection metadata. The saved-session site saw
no session, so the agent used the password. The stale-session site was never
offered the expired cookie, and webdecoy's isolation metadata (`new_user_persistent`,
`auth_source none`, counts 0) could not match. The deepest owned cause is that
first materialization and private-state resume shared one contract. The plan
(code-agent-persistent-sessions.md) requires a resumed browser to refresh its
credential versions and a new browser to start from the Home baseline; with an
empty baseline that is the provider profile plus the account credentials.

## Solution

`initSession` initializes a logical row that has never materialized and holds no
private state (no own checkpoint, empty Home baseline) through the normal init
contract, bound to the logical row ID. The real persistence compare-and-swaps
`sessionId NULL` to the new session, keeping `logicalOwnerKey` and the baseline.
A concurrent first init that loses that race follows the winner through the
existing coalescing resume path. `prepareSessionCredentials` withholds
shared-store injection only from logical rows that hold private state. Logical
browsers with their own checkpoint or a non-empty Home baseline keep the
branch's resume semantics unchanged. 10k-agent behavior: one row per agent as
before, no new queries on the hot path beyond two scalar checks on the row
already read, and no shared state or fan-in.

## Human feedback

None recorded.

## Reusable lesson

When a lazy logical resource replaces eager creation, give its first materialization the original create contract, and reserve resume semantics for state that actually exists.
