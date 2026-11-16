---
id: 2026-11-14-abandoned-browser-checkpoint-kept-lifecycle-claim
date: 2026-11-14
title: Abandoned browser pause kept checkpoint capture and lifecycle custody alive
surface: back-end
component: browser-checkpoint-capture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Close route did not propagate caller disconnect to pending checkpoint capture under withLogicalBrowserPause
symptoms:
  - 'Browser session init failed after 5 transient-proxy retries: {"error":"Browser resume is still in progress"}'
  - "Browser resume is still in progress"
  - "steel_browser_task_lifecycle"
tags:
  - browser
  - checkpoint
  - cancellation
  - lifecycle
  - tilion
sources:
  - PR #2085
  - agent 8789a5df-0119-4bbf-b90c-c7e58de56fe4
  - commit 57c3e35899f05b3eec9bca465ba825050b0aaa20
repro: back-end/src/tests/blackbox/browser-session-pause-abort.cases.ts
status: mitigated
---

## Problem

On November 14, Amazon furniture lookup completed, but the next three mover/storage
quote browsers failed before any website action. All reused logical browser
`2944067d-fb57-51a2-ab34-9a7e5dcf862b` and Tilion native
`sess_98241ca47afb479588d9252f1837f9b9`. The first init after cleanup returned
HTTP 500 after 30.303 seconds; fifteen init requests failed across three serial
browser activities occupying 530.365 seconds. The generic worker label
"transient-proxy" did not establish a proxy failure.

The blocking row was the prior pause's `steel_browser_task_lifecycle`, not
`browser_task_resume` or `browser_session_initialization`. Its owner
`06818fa8-4635-4765-ba32-1184ce207e2b` acquired custody at 18:39:47.466Z,
`nativeOutstanding=false`, expiry 19:14:47.466Z. It remained STARTED, response
null, updatedAt 18:39:47.499Z. Browser status was PAUSED, checkpointRevision 0,
checkpointRef null. Initialization had succeeded at 18:31:26.400Z.

## Diagnosis

Critical path: worker terminal pause -> HTTP close -> provider close wrapper ->
logical pause owner -> PAUSED mutation -> checkpoint capture -> provider release
-> lifecycle release. Subsequent init joins the same lifecycle key and waits
behind any STARTED non-resume owner.

Worker CDP detached at 18:39:47.213Z. Backend close request `337c7fcb370c` began
18:39:47.450Z; it attached CDP successfully at 18:39:47.791Z (one context/page).
There was no later request event through 19:03Z, and no checkpoint publication.
The same backend instance served other requests after the worker's 60-second
close budget elapsed. Worker reported cleanup failure at 18:40:51.179Z. The
close route had no disconnect handler, so a pending capture could keep its
transport and lease after the caller left. A resume follower cannot safely
ignore that owner. The specific original pending Playwright/storage/artifact
operation and delivery of the production socket-disconnect event were not
recorded; neither IndexedDB nor a provider outage is established.

Local reproduction uses actual Chromium, Prisma, logical pause, checkpoint, and
resume lifecycle. A pending Runtime.callFunctionOn after successful attachment
keeps PAUSED/STARTED. The unchanged production 30-second follower wait emits the
literal reported error. Aborting the caller on original code does not settle
capture; the regression fails. After the correction it disconnects only that
capture client, joins the pending call, preserves the original native/private
state and permits the next lifecycle owner. A separate real HTTP socket test
executes the actual route and service to verify disconnect reaches the provider.

Archive searches: `Browser resume is still in progress`, `Browser session init
failed transient-proxy`, and `checkpoint capture pending lifecycle pause`.
This is related to October 23 rejected-create custody and October 28 failed
hydration, but neither native create nor replacement hydration occurred here.
The October 29 single-CDP pause collision is excluded by successful backend
attachment after worker detach. November 13 Tilion init latching is a different
receipt, native worker and error. Actual peer work was read and owners of
PRs #2010/#2021/#2069, #2031 and #2065 consulted; #2065's owner confirmed its
provider-ended recovery does not repair this pending pause claim. Folder listing
exposes Bugs but not membership to ordinary devboxes; project-wide discovery
and evidence reads were used, and the discovery limitation was reported.

## Solution

The HTTP close caller owns an AbortSignal passed through service/provider to
logical pause and checkpoint capture. An abandoned capture closes only its exact
registered temporary pages and CDP client. Creation promises are registered
before awaiting so late results remain owned; aborted work cannot admit another
scratch creation. Normal and abort cleanup share each close promise. Capture
joins cleanup before restoring ACTIVE and releasing its existing fenced claim.
Checkpoint publication checks the signal. Once provider retirement starts,
caller abort cannot roll the completed pause back to ACTIVE. No timeout, retry,
lease duration, prompt, schema, native allocation or provider deletion policy
changes. Existing upload middleware is reused from domain config to remove the
route's existing lint suppression without changing its settings.

Review caught and rejected disconnect-first cleanup: Playwright CDP disconnect
preserves remote targets, so it leaked the checkpoint scratch page. It also
caught short-circuiting after a confirmed page-close error. Exact page closes now
join with allSettled; transport cleanup still finishes before that error returns.
SDK storageState can create hidden targets; admitted SDK work is joined while
connected so its own cleanup can run. Unknown/unsettled work retains custody.
The fix does not promise prompt release for an arbitrary uninterruptible SDK,
DB or artifact operation. The historical exact suboperation remains an open
observability gap; this status is mitigation, not proof every original cause is
eliminated. Added capture-phase markers distinguish tab capture and storage.

Regression controls preserve the original native and exact target set, localStorage
and private checkpoint, sessionStorage, live-caller custody, already-aborted
admission, delayed transport close, normal durable checkpoint-before-release,
late abort after provider retirement starts, confirmed target-close failure,
and admitted SDK-work custody. Both tests run in the normal browser-session
backend blackbox deploy lane. Local DB is an isolated schema-only
`victoria_rca8789_test`; no production fixture writes were made.

Exact owning command from the repo root:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca8789_test DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca8789_test CONDUCTOR_WORKSPACE_NAME=rca8789-test node --import tsx back-end/src/tests/blackbox/browser-session.blackbox.ts --pause-abort-only
```

Original command exit 1: the pending capture did not settle after caller abort.
The enhanced exact-symptom reproduction also exit 1 after first observing
`Browser resume is still in progress`. Intermediate scratch-leak regression
exit 1; those outcomes are retained. Final verification and deployment results
will be appended when complete. Sensitive original rows, signed transports,
logs and dumps remain outside Git under `.context/rca-8789/` for private archival.

At 10k agents ownership stays per task, with O(owned temporary pages) bookkeeping,
no shared queue/scan, no extra paid browser allocation, and one signal listener
per in-flight close. Pending unknown work remains visible and fenced.

## Human feedback

The user required reading other active bug investigations and reconciling actual
work/evidence before editing, then completing deployment after RCA. No routine
request revokes the standing instruction to preserve Freedom.

## Reusable lesson

Propagate caller cancellation to owned capture resources and join exact cleanup
before releasing lifecycle custody, while retaining custody for unknown work.

### Final local proof and introduced verification repair

At `6da67bf6bb36e05891d97d53c224318842178465`, the final owning command
above passed five consecutive unchanged runs (`stable-6` through `stable-10`),
all exits 0 with all source hashes checked. Each took 31.2–31.4 seconds. The
original basic reproduction exited 1 in 13.2 seconds; the enhanced reproduction
first observed the literal 30-second custody error, then failed the unchanged
caller-abort assertion (exit 1, 40.5 seconds). Route/socket disconnect regression
also passed five times. Independent code/flakiness review passed that source;
backend TypeScript, formatting, lint and structural quick gates passed. The
approval batch reported empty flagged-file/guard scope: Golden reference not
applicable (no approval-gated hunk). An unused conservative packet draft was not
GROUNDED and is not approval evidence.

The first full Blacksmith backend gate (GitHub run `43632440309`) passed every
blackbox domain, including browser-session and these new regressions. It failed
one of 425 unit files: `browser-session-metadata-only.test.ts` threw
`Error: Unexpected dependency ./config`. The VM fixture still mocked a direct
multer import after the route reused its already-existing domain configuration.
The isolated unchanged unit passed on parent `57c3e35899`, failed on `6da67bf6`,
and passed five times with only the fixture's dependency adapter corrected.
All metadata/ownership assertions and upload middleware signature were retained.
This failure is INTRODUCED and owned here; the original units FAIL and partial
coverage-threshold UNVERIFIED remain recorded. Focused passes do not replace
full coverage acceptance.

Supported focused unit reproduction, from back-end:

```bash
BACKEND_UNIT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca2085 BACKEND_UNIT_TEST_FILES=browser-session-metadata-only.test.ts BACKEND_UNIT_CONCURRENCY=1 npm run test:unit
```

The fixture correction arrived while independent gates completed, so the first
native cycle became STALE with its two original pending failures. Triage
correctly refused that stale boundary. After confirming all sixteen quick/full
receipts were terminal with zero live owners or smoke admissions, the complete
cycle was preserved intact for audit. A fresh final-source cycle reruns the
complete selected inventory with no stale-source credit. The deploy clock is
unchanged. PR #2085 retains the original failures and the subsequent repair
proof; final full-gate and production results are recorded at closeout.

### Shipped mitigation and production proof

PR [#2085](https://github.com/Rose-Ai-Labs/rose/pull/2085) merged as
`620d1f6049969d292dea8c60af9cbdcc134f29b6` on November 14. The exact
merge became live on Render at 21:26:23Z; all 15 backend endpoint probes passed.
Production semantic run [43643526394](https://github.com/Rose-Ai-Labs/rose/actions/runs/43643526394)
used that exact source input and passed all five jobs at attempt 1. GitHub quota
errors interrupted dispatch metadata lookup and later observation; the same
already-dispatched run was resumed read-only, without reexecuting tests.
The older aggregate FAIL receipt remains preserved alongside the final native
semantic PASS, rather than being rewritten.

The final selected deploy cycle satisfied all 17 gates under their native
qualification rules. This does not mean every underlying test passed: actual
smoke had 10 passing tasks and one existing quarantined payment assertion failure.
The historical payment-abandonment task remained NO_RETRY_CUSTODY/SKIP with no
current execution or financial-cleanup credit. CodeRabbit's organization spending
cap prevented a review; the native allowed skip was recorded and the PR was
merged unreviewed by CodeRabbit. Independent code and test-flakiness reviews passed.

Two failures independently reproduced on both the original parent and candidate
were handed to separate repair goals after merge: common wrapper fixture contracts
and the payment lifecycle transfer-counter assertion. Their original failures
remain failures. Private native records, attribution proofs and all earlier
failed attempts are recoverable through the closeout archive catalog.

RCA outcome recorded once: **diagnosis-ready**. The demonstrated caller-abandonment
mechanism is repaired and deployed. The original pending capture subcall and
production disconnect delivery remain unobserved, so the case stays **mitigated**.
No manual production browser-row repair or claim of recovered historical quotes
was made.
