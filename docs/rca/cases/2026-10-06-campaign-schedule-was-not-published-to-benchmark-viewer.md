---
id: 2026-10-06-campaign-schedule-was-not-published-to-benchmark-viewer
date: 2026-10-06
title: Independent campaign children appeared as separate benchmark runs
surface: cross
component: benchmark-campaign-hub
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run-bench-campaign retained its schedule locally without publishing campaign membership
symptoms:
  - one fifty-copy CLI campaign appeared as separate frontend run rows
  - missing child publications hid scheduled copies
  - repeated identical task names had no campaign member identity
tags:
  - benchmarks
  - campaign
  - frontend-status
  - publication
sources:
  - PR #1422 follow-up
  - fleet run 20261006-180139-2969
repro: scripts/tests/campaign-hub-grouping.test.sh
status: mitigated
---

## Problem

The fifty-copy CLI campaign created fifty independent fleet run IDs with no
shared published group identity. Authenticated runtime catalog observation
found five published terminal rows, each a separate one-task run. Missing
publications were not represented by the local scheduler's full task list.
This did not prove task execution or successful publication for all fifty.

## Diagnosis

Runtime evidence was collected before archive searches for campaign parent
registration and benchmark viewer grouping. The
[unregistered-parent case](2026-09-09-campaign-synthesized-unregistered-hub-parent.md)
forbids inventing a parent ID that disables child-owned publication. Here the
local scheduler had a valid complete schedule, but did not publish it or
immutable child membership. Grouping by task name or timing would also merge
unrelated campaigns and lose repeated copies.

The unchanged supported scheduler/upload/Express API controls produced five
behavioral failures and one passing history inverse on the original source,
then six passes after repair. Unchanged frontend controls failed twice before
repair and passed twice afterward. These were behavioral assertions, not
missing imports or unavailable new test functions.

## Solution

The scheduler publishes a real Hub schedule and assigns each child a stable
campaign/member identity. Child starting, live and final publication and exact
guest ACK ownership stay independent. The viewer projects compact child
summaries into one group, preserving distinct repeated rows and child links.
Early evaluator PASS/FAIL remains visible before teardown. Missing terminal
controller results use genuine controller facts and never imply resource release.

Immutable membership, final-state absorption, original elapsed time and bounded
paging protect recovery and live updates. Raw internal catalog and legacy API
contracts stay intact, so task-selection history beyond one hundred rows is not
lost. Group polls read no archived child bundles. Ten-thousand-member metadata
is covered without adding a live workload.

The six compact scheduler/API controls run in `scripts/test.sh`; the two viewer
controls run in ordinary frontend blackboxes. Existing fifteen Hub ownership
and three cancellation/reaping controls also passed. Root integration exposed
a test dependency-resolution difference hidden by the private candidate's
module link; dependencies now resolve through the backend package owner.
Native fifty-copy execution, frontend deployment and release proof remain
outstanding, so this case is mitigated.

Review follow-up at `c214f519` exposed a reverse namespace reservation gap.
Existing owner-less children reserved a group ID, but a later plain physical
run (or a member of another group) could write that same ID. The grouped
catalog then had two rows with one identifier, coupling detail and deletion.
The store now checks that reservation inside the existing index lock before
any durable bundle write. Valid schedule adoption of matching early children
and unrelated physical runs remain supported.

The identical registered API/store controls produced six passes and two
failures on original source in 3.005 seconds, then eight passes in 2.991
seconds. Refusal-before-write, detail, late adoption and exact deletion are
permanent inverses in the existing campaign-grouping gate. Native observed
leaders and listeners are absent. This is a contract extension found during
review, without live trial or production mutation; combined backend coverage
and the grouped production rollout remain pending.

## Infrastructure retry protocol extension (2026-10-08)

The user authorized automatic retries only for infrastructure errors, inside the
original 90-minute end-to-end clock and unchanged 20-minute task bound. This is a
new requested capability, not proof that a failed benchmark outcome was repaired.
The existing duplicate-member guard correctly refused a second physical run;
removing that guard would erase ownership and let genuine FAIL results be retried.

Actual uploader inspection shows infrastructure bundles can carry `passed: false`
alongside the explicit `INFRA_ERROR`/`error` terminal marker. The archived payload
keeps that original sentinel. Canonical summaries normalize only those explicit
infrastructure statuses to `passed: null` only when the original verdict is not
true. A genuine true verdict remains authoritative even if an infrastructure
marker contradicts it; ordinary task PASS/FAIL still wins over raw agent statuses
such as ACTIVE. Independent review exposed the contradictory-true sibling: its
permanent refusal control failed with “Missing expected rejection,” then passed
unchanged after preserving true. No benchmark outcome was changed.

Optional `group_attempt` identifies a physical attempt of the same immutable
logical member. Omitted metadata retains legacy attempt-one semantics. Under the
existing index lock, a new explicit next attempt requires the complete contiguous
history and a prior canonical one-task physical run that is terminal, has
`passed: null`, status `INFRA_ERROR` or `error`, and lifecycle `released`. Its task,
run number, original group timestamp, and total must match. Same-attempt collisions,
live/unreleased attempts, actual PASS/FAIL, cancellation, gaps, and changed
membership are refused before durable writes. Recovery can omit metadata on an
existing physical run; its committed attempt membership remains authoritative.
The group's original schedule timestamp also cannot be rewritten.

The catalog selects the highest explicit attempt per logical member and retains
compact earlier status, cost, lifecycle, and exact child/agent identities. Fifty
members remain fifty rows; all actual physical-attempt costs, tokens, and agent
counts remain in totals. Group detail reads no archived bundles. Existing group
removal still removes every exact child. The viewer expands attempt history and
opens each available agent through its original physical child identity.

The permanent existing grouping control demonstrated the old guard's actual
refusal, then the unchanged retry/refusal controls passed through the real store
and detail owners. Ordinary quick-gate discovery includes them. The viewer's
unchanged control first failed because it had no attempt history, then passed
with both exact links and the original infrastructure error visible. Source
qualification and independent review remain required before rollout; no live
benchmark task, paid dispatch, acceptance credit, or successful retry is claimed.

Independent review inspected all eleven frozen public files and the actual
unchanged RED/GREEN proof, then reran the normal group family (23 passes) and
viewer controls (three passes). Every actor joined; no model/provider calls or
production mutations occurred. The reviewed protocol is source-qualified, while
live retry outcomes and deployment qualification remain outstanding.

Archive searches used the literal duplicate-member error and the behavioral
terms “group retry attempt infrastructure error released.” This extends the
existing campaign membership contract. The vendored Claude reference separates
permanent failures from bounded transient retries in
`claude-code-src/src/remote/SessionsWebSocket.ts:246` and
`claude-code-src/src/services/teamMemorySync/index.ts:394`. Searches of the local
OpenClaw sources found generic retry owners without this benchmark group
projection. Hermes separates each durable attempt from aggregate incident state in
`hermes-agent/cron/incidents.py:1` and records immutable terminal attempts in
`hermes-agent/cron/executions.py:243`; this converges on preserving earlier attempts
while projecting their logical member. A local Codex reference
checkout is absent. No new registry, queue, or synthetic completion state was
introduced; durable physical summaries remain the source of truth.

## Human feedback

The user required every CLI batch to remain together in the frontend viewer,
correct live states, immediate PASS/FAIL before cleanup, compact permanent
deploy tests and parallel optimization. Avoid invented completion and
unnecessary acceptance resets. The user later explicitly required infrastructure-only
affected-task retries, preserved original attempts, and a 90-minute total clock
with the 20-minute per-task bound unchanged.

## Reusable lesson

Publish immutable campaign membership while preserving each child's independent result and cleanup owner.
