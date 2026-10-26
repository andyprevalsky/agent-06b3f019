---
id: 2026-10-26-fixed-create-delay-raced-second-custody-child-startup
date: 2026-10-26
title: Resume custody 'incompatible' fixture raced a fixed 1000 ms create delay against the second child's process startup
surface: back-end
component: browser-session-resume-custody-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts 'incompatible' scenario — a fixed 1000 ms provider-create response delay was the only thing keeping the first resume's custody STARTED while the second forked child booted
symptoms:
  - 'assert(!results[1]!.ok) at back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts:302'
  - 'Crashed: AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert(!results[1]!.ok)'
  - '[Retry] Retry: attempt 109/1000 returned a retryable result, retrying in 10ms'
  - 'browser-session domain fails intermittently in npm run test:coverage under memory/CPU pressure'
  - 'incompatible scenario: creates 2, both resumes ok'
tags:
  - browser-session
  - resume-custody
  - fixture-race
  - child-process-startup
  - flaky-gate
sources:
  - commit 5cf8340c9
  - commit 7c71f4c7d
  - commit 9ded72d13 (deploy/devbox-20261026-ui26, Step 4a backend coverage failure 2026-10-26T20:41Z; log /tmp/ui26-int/browser-session-fail.log, not committed)
  - commit 91af4fe0a (origin/main, same failure 1 of 5 runs under memory pressure)
repro: back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts (browser-session domain, scenario 'incompatible')
status: fixed
---

## Problem

The `/deploy` backend coverage gate for `deploy/devbox-20261026-ui26` passed
227/227 at ~19:45Z, then failed at 20:41Z in the `browser-session` domain with
`assert(!results[1]!.ok)` at `browser-session-resume-custody.cases.ts:302`
(called from `browser-session.blackbox.ts:611`). Nothing in between touched the
area. A separate thread saw the same failure on plain `origin/main` 91af4fe0a
in 1 of 5 runs while the box had only 2-3 GB of free memory. In the failing log,
the wait loop for the first child's create needed 109 tries (~1.17 s for that
child to boot and reach the provider). The failure was in the ninth custody
case, `browser-use` / `incompatible`.

## Diagnosis

The scenario checks that a default resume is rejected while an incompatible
(`forceFreshProfile`) resume is still in flight. The fixture forked the first
child (fresh), waited until the fake provider had received its create, and then
forked the second child (default). The only thing keeping the first resume in
flight was a fixed `setTimeout(..., 1000)` on the create response.

When the second child is not yet running, the first child's custody row
(`ToolSideEffect` `steel-browser-task-lifecycle:<id>`) stays STARTED for roughly
1000 ms plus hydration. The second child needs about the same time to fork,
load tsx and the provider modules, and connect to Postgres. Under memory or CPU
pressure the second child's startup takes longer. Its
`withBrowserResumeLifecycle` read (`back-end/src/providers/steel/lifecycleClaim.ts`)
then finds a RELEASED row with a `fresh` ready receipt. A `default` request does
not follow that receipt, and its `initial` binding read already sees the new
native session, so it correctly claims and creates its own browser. Both resumes
return ok with creates=2, and the assertion fails.

That is the correct product behavior for a sequential resume. The fixture was
asserting in-flight semantics without guaranteeing that the two resumes overlap.

Deterministic local repro (temporary 1500 ms wait before forking the second
child, standing in for slow child startup, on deploy HEAD 9ded72d13):
`CONDUCTOR_WORKSPACE_NAME=ui26-custody-flake BLACKBOX_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:56105/victoria_ui26-custody-flake bash scripts/run-blackbox-tests.sh browser-session`
failed with the identical `assert(!results[1]!.ok)` crash. The scenario
diagnostic showed `"scenario":"incompatible","creates":2,"hydrations":2` with
both results `ok:true` and different session ids. Natural runs under 8 CPU
spinners passed 2/2, so CPU load alone rarely crosses the margin. Memory
pressure (slow module loads) does.

## Solution

The fixture now holds the first provider create response on a promise and
releases it only after the second child has reported its outcome
(`run().finally(releaseHeldCreate)`, plus a release in `finally` so
`server.close()` can't hang on a held request). The second resume always meets
STARTED in-flight custody, whatever the startup time. The assertion is
stronger: `incompatible` must now fail with `incompatible with the in-flight
operation`, not with some other error. A product regression that waited or
followed instead of rejecting would now block the held create and fail through
the 10 s fixture timeout instead of passing by timing. The same 1500 ms injected
delay passes with the fix. No product code changed, so behavior at 10k agents
is unchanged.

The sibling `fresh-concurrent` scenario has the same latent shape: it relies on
two simultaneous forks overlapping, which a large startup skew could defeat.
It did not fail in these runs.

## Human feedback

None recorded.

## Reusable lesson

When a multi-process fixture asserts in-flight semantics, hold the first
operation on an explicit test-controlled gate until the second has observed it;
never use a fixed response delay to cover another process's startup time.
