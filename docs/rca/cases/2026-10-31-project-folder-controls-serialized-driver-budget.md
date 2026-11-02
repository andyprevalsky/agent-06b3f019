---
id: 2026-10-31-project-folder-controls-serialized-driver-budget
date: 2026-10-31
title: Folder controls acceptance exhausted its deadline across expensive desktop driver operations
surface: harness
component: project-folder-controls-playwright
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: project-folder-controls desktop scenario accumulated driver time before its final assertions; original CI scheduling and renderer cause is unmeasured
symptoms:
  - "Test timeout of 90000ms exceeded"
  - "folder ordering, icon counts and project collapse at 1280px"
tags:
  - playwright
  - folder-controls
  - semantic-gate
  - driver-serialization
  - resource-sensitivity
sources:
  - PR #1651
  - commit bccde16b1c33c8d75621068bf9d97bf3802098e6
  - commit f0e250c6f184a2d3412b3d671e99e3f6620a5340
  - agent ph7dbr4a6n4nyz48k82brswy9n8h4c8e
repro: front-end/tests-e2e/project-folder-controls.spec.ts in the full production UI cohort with SEMANTIC_WORKERS=4 and taskset -c 0
status: open
---

## Problem

PR #1651's exact production verification, workflow 41158186015, passed the
folder scenario at 1280px in 56.1s, all 29 production UI cases, and all 20 chat
latency samples. A later deploy's workflow 41163473580 failed the desktop
scenario twice at the unchanged 90s global deadline. All other 28 UI cases and
four chat-lifecycle jobs passed. The six production exclusions were intentional
local-only scenarios, not new skips. The frontend tree is byte-identical between
bccde16b1 and f0e250c6f. These are separate release outcomes.

## Diagnosis

The first failed trace reaches its final label visibility assertion after the
deadline; that label is visible at +91.6s. This does not pass the timed assertion.
The trace contains no earlier independent functional assertion failure.
Navigation/reload, mouse movement and hovers consume 45.702s of non-overlapping
API intervals in attempt 1 and 55.293s in attempt 2. All API responses are
intercepted. Nested API durations and overlapping requests must not be added
as serial time. There is no evidence blaming the production folder backend.

An unchanged full four-worker UI cohort on this eight-CPU machine passed all
29 cases (desktop 15.3s); two-CPU affinity also passed (desktop 49.3s). One-CPU
affinity reproduced the 90s desktop timeout, with 28 other cases passing. Its
initial/reload hovers took 13.335/10.386s; first icon and badge bounding-box
reads took 6.849/3.499s sequentially. Process samples confirm descendants were
pinned and runnable scheduling waits accumulated. This establishes resource
sensitivity, not an identical CI host mechanism. Original CI scheduling,
renderer long tasks and Node event-loop evidence were not captured.

Archive searches included the exact timeout and sidebar/render slowdown. The
October 2 renderer-stall case is relevant precedent, not proof of recurrence;
the October 5 network-idle case does not apply because this scenario uses
DOMContentLoaded.

## Solution

No incident fix is established. Three driver-only candidates were reviewed and
stress-tested, then reverted:

| Candidate | One-CPU full-cohort result |
| --- | --- |
| Parallel original geometry/style calls, remove unasserted QA PNG | Desktop timeout, 28 passes, 6 exclusions |
| Also replace middle reopens with open-state assertions and add separate re-entry coverage | Desktop timeout plus old project-flow failure, 27 passes, 6 exclusions |
| Restore all four exit/re-entry sequences, use physical entry with visible/closed/open assertions | Desktop timeout, 28 passes, 6 exclusions |

None changed the 90s deadline, four workers, 180 agents or functional geometry,
count, ordering, persistence and destination assertions. None is committed as a
fix. The one-CPU envelope is deliberately harsher than nominal two-vCPU CI;
matching only its final timeout location does not prove the original cause.

The unchanged full folder scenario with browser CPU throttling passed at 4x
(35.7s) and 6x (56.7s). First-reveal browser task durations were 6.925/9.502s;
last-reveal durations were 4.121/6.703s. Disabling automation capture in a
**diagnostic control only** still measured 6.076/3.648s of browser task work.
These measurements include app boot; they are not isolated hover costs or a
passing substitute for the canonical traced cohort. The first CPU profile
covered only the post-reload 10.51s; subsequent diagnostic profiles explicitly
segment each reveal.

The retained final browser-wide trace contains 789 starts for each of
border-top/bottom/left/right color. Earlier tool observations of agent-label
span animations led to inspecting this path; that initial raw trace was later
removed by overlapping default Playwright output cleanup, so it is not cited
as a retained artifact. The final trace and diagnostic controls are retained. Source
`useLoginDarkMode.ts` activates `html.rose-login-theme-transition body *`, which
forces color/border/fill/stroke easing across descendants. A 4x/2-CPU diagnostic
counterfactual disabling only this transition property reduced first-reveal
task time 7.282 to 4.778s and style time 1.243 to 0.439s, with border transitions
789 per side to zero and ordinary padding/opacity/width animation counts
unchanged. Repeated ABBA comparisons were 35.5/35.7s baseline versus
31.7/31.9s disabled, with first-reveal task time 7.282/7.782 versus
4.778/4.642s. These support a real cost in this product path; an unchanged
acceptance reproduction is still required before attributing the CI deadline. No product optimization is shipped by this
observability change, and no 10,000-agent performance claim is made.

The follow-up adds optional browser-instance CDP tracing spanning navigation
and reload, plus Node CPU, event-loop delay and Linux main-thread scheduling
counters. Existing production artifact upload collects the attachments on pass
and failure. Original scenario body, viewport cases, deadline, fixture and
assertions stay unchanged. Observer artifacts require independent capture
validity; a functional pass is not proof of a complete profile. Instrumentation
adds measurable load and must remain identified in comparisons. Final two-CPU validation used four workers and passed all 29 original UI cases
plus seven pure observer checks, with the same six exclusions (42 collected,
36 passed). Desktop Node observation window was 63.02s and finalization before
metadata 12.03s. This is not a paired overhead measurement against the earlier
49.3s uninstrumented baseline: seven extra pure cases also affect scheduling.
The retained profile reports valid observed-event coverage, no data loss, both
fixed clock markers, three main-frame commits, 322,348 CPU samples, and confirmed
stream close/session cleanup. Decoded input was 22.65 MB and projected output
12.18 MB; Node RSS before metadata was 358.7 MB. CPU sample/parent references
are complete when grouped by process plus native profile ID (chunks can arrive
on different threads). Sensitive-field sentinel checks and emitted-field scans
passed. The previous hardened run passed functionally but had only a start
marker; it remains a partial capture, not retrospective completeness proof.

Private negative lifecycle diagnostics deliberately caused a 250ms test timeout
and an owned-browser shutdown, then ran a fresh worker. Expected command exit 1
and statuses timedOut/failed/passed were validated separately from acceptance.
The timeout preserved functional status and both trace markers; browser shutdown
recorded observer failure separately from functional pass, retired the browser,
and a new worker succeeded. No acceptance deadline was changed by these
observer self-checks. Privacy projection uses fixed event/argument fields; raw
DOM names, arbitrary strings, credentials and URL parameters are not published.

Local raw receipts are under `.context/project-folders/followup/`, including
`timeout-comparison.json`, original native traces, all three failed candidate
artifact directories, CDP 4x/6x profiles and `product-theme-*-phases.json`.
`later-local-red.log` is an unchanged **passing** baseline despite its filename.
These private files are local evidence, not durable public links. GitHub
workflow logs preserve the original production outcomes. The deployment
coordinator owns the next native production semantic dispatch after integrating
this observability-only PR; a failure is diagnosed rather than retried blindly.
The RCA remains open pending mechanism and outcome evidence.

2026-10-31 follow-up (deploy 11, run 41232225640, both attempts red): the
mechanism is confirmed as runner oversubscription, not driver serialization.
With identical source, every UI case in the cohort scaled 1.5-1.8x between the
green and red runs; the desktop folder case (59s at the fastest runner) was
simply the longest one against a 90s deadline. The production gate ran four
Chromium workers on the private-repository runner's two vCPUs because
`run-semantic-tests.sh` sized workers only in local mode, and the profiling
fixture this case added (CI default) cost ~10s of the body in isolation.
Diagnosis, measurements and the fix (capacity sizing in production mode,
profiler opt-in) are in
`2026-10-31-production-semantic-gate-oversubscribed-two-vcpu-runner`. The
"partial profile" classification of the red receipts (`trace-write-failed`)
is separate from the retry attempts and unchanged by that case.

## Human feedback

The user permits skips for specified third-party credit/AgentCard or unrelated
failures, and explicitly asked us to check and repair issues we introduced.
This owned test timeout is not classified as an unrelated allowed skip.

## Reusable lesson

Retain failed resource-constrained experiments, distinguish measured driver
cost from unobserved CI scheduling, and preserve interaction coverage explicitly
when removing repeated setup work.
