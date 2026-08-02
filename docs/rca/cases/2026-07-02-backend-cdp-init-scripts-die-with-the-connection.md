---
id: 2026-07-02-backend-cdp-init-scripts-die-with-the-connection
date: 2026-07-02
title: Backend CDP init-script injections die when the connection closes and are never re-applied by the worker
surface: back-end
component: browser-session-injection
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end browser injection.ts — indexedDB/permissions/cacheStorage init scripts are bound to the backend's CDP connection lifetime
symptoms:
  - indexedDB/permissions/cacheStorage injections are silent no-ops in prod
  - injected browser state absent in the worker's page despite backend reporting injection success
  - backend fingerprint CDP branch had no observable effect
tags:
  - browser-agent
  - cdp
  - steel
  - injection
  - silent-failure
sources:
  - memory:project_browser_spinup_optimization
repro: none-recorded
status: open
---

## Problem

While profiling browser spin-up (44.6s baseline), the backend's browser
injection path was found to have no observable effect in production: the
`indexedDB`, `permissions`, and `cacheStorage` init-script injections in
`injection.ts` are silent no-ops. The backend reports them as applied, the
worker's page never has them.

## Diagnosis

CDP `addScriptToEvaluateOnNewDocument`-style init scripts are scoped to the CDP
connection that registered them. The backend registers them and then closes its
connection; the registrations die with it. The worker, which owns the page for
the rest of the run, does **not** re-apply them.

The same mechanism explained a second finding in the same investigation: the
backend fingerprint CDP branch was pure dead work — it also died with the
connection, and the worker re-applies fingerprint itself, so deleting the
backend branch changed nothing. Fingerprint was accidentally covered by worker
re-application; indexedDB/permissions/cacheStorage were not, so they silently
vanished. The deeper owned cause is a cross-process split of browser setup where
one side's effects are connection-scoped but the ownership handoff carries no
re-application contract.

## Solution

The dead backend fingerprint CDP branch was deleted as part of the spin-up work.
The indexedDB/permissions/cacheStorage no-op was recorded as a latent bug
needing its own fix — either move those injections to the worker (which holds
the durable connection) or have the worker re-apply them after connect, the same
way it already re-applies fingerprint. Not fixed in the recorded session.

## Human feedback

None recorded.

## Reusable lesson

Any browser setup performed over a CDP connection that the setup process then
closes is a no-op unless the process that owns the page re-applies it — verify
injected state from the page owner, not from the injector's success log.
