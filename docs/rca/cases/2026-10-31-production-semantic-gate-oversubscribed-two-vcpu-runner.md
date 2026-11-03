---
id: 2026-10-31-production-semantic-gate-oversubscribed-two-vcpu-runner
date: 2026-10-31
title: Production semantic gate ran four Chromium workers on a two-vCPU runner, so the longest UI case exhausted its deadline whenever the runner was slow
surface: harness
component: production-semantic-gate-runner-sizing
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: front-end/scripts/run-semantic-tests.sh prod mode skipped semantic_workers_for_capacity, so chat-lifecycle-ratchet.yml's SEMANTIC_WORKERS=4 launched four Chromium workers on the private-repository ubuntu-latest runner's two vCPUs
symptoms:
  - "Test timeout of 90000ms exceeded"
  - "Error: locator.evaluateAll: Test timeout of 90000ms exceeded"
  - "Error: locator.click: Test timeout of 90000ms exceeded"
  - "folder ordering, icon counts and project collapse at 1280px"
  - "Error: Diagnostic observer cleanup failed; restart worker"
tags:
  - playwright
  - semantic-gate
  - github-actions
  - worker-sizing
  - folder-controls
  - cpu-starvation
sources:
  - commit 9aefb865b (deploy 11 merge; GitHub Actions run 41232225640, both attempts red)
  - commit 0b6d20996 (deploy 10 merge; run 41219927913 green at 78s)
  - commit 76c2e4a06 (deploy 9 merge; run 41203004357 red then green)
  - commit 8a61c9d63 (profiling fixture enabled in CI by default)
repro: scripts/tests/semantic-deploy-gate.test.sh (prod-mode sizing cases) and front-end/tests-e2e/project-folder-controls.spec.ts under `taskset -c <one core>` with four workers
status: fixed
---

## Problem

Deploy 11 (merge 9aefb865b) failed the production semantic gate twice
(GitHub Actions run 41232225640, attempts at 19:01Z and 19:09Z):
`project-folder-controls.spec.ts:6` "folder ordering, icon counts and project
collapse at 1280px" exceeded its unchanged 90s test budget in both attempts
(`Test timeout of 90000ms exceeded`, 1.7m reported) while the 390px variant and
the other 35 UI cases passed. Deploys 10 -> 11 changed no front-end or back-end
file, so production bytes and the test source were identical to deploy 10
(run 41219927913, green at 16:29Z) and to the green comparator run 41174479792
(05:56Z, 59.0s). Deploy 9 (run 41203004357) had already failed the same case
once and passed on retry.

The Playwright traces of both red attempts show no stuck step: 169 actions over
94.6s / 91.8s, every hover, click and wait 1-11s, the first `rose-sidebar` hover
11.1s / 11.0s, the post-reload hover 7.7s. The fixture receipt
(`folder-runner-profile.json`, capture `partial`, reason `trace-write-failed`)
records the Node worker's `/proc/self/schedstat` over the ~100s body:
run 2.3s, wait 15.9s. The green comparators show the same wait/run ratio
(8.9/1.4s at 59s; 12.3/1.9s at 80s), so the ratio is the runner's steady
state, not the discriminator; the magnitude (wall) is.

## Diagnosis

**Critical path.** `chat-lifecycle-ratchet.yml` -> `run-semantic-tests.sh --prod`
-> Playwright (4 workers, trace + video recorded for every test) -> one
Chromium per worker rendering https://www.roselabs.ai -> the 1280px folder
scenario (route-mocked API, 180 agents) -> its 90s deadline.

**First-bad boundary.** `front-end/scripts/run-semantic-tests.sh` applied
`semantic_workers_for_capacity` only in local mode ("the production gate runs
on a dedicated CI runner whose worker counts the workflow pins explicitly").
`ubuntu-latest` for a private repository is 2 vCPU / 8 GB (GitHub-hosted
runners reference, read 2026-10-31), so the gate ran four Chromium workers,
four ffmpeg video encoders and four trace screencasts on two vCPUs.

**Discriminating evidence (CI, identical source).** Every UI case in the
cohort scales together between runs; the folder desktop case is only the
longest one. Durations in seconds (list reporter), ratio to the fastest run:

| case                                 | 05:56 green | 16:31 green  | 12:54 red    | 13:01 green  | 19:01 red    | 19:11 red    |
| ------------------------------------ | ----------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| agent-display-panel 1280             | 29.1        | 35.2 (1.21x) | 39.6 (1.36x) | 34.4 (1.18x) | 45.6 (1.57x) | 41.3 (1.42x) |
| code-agent codex                     | 25.2        | 34.0 (1.35x) | 43.1 (1.71x) | 31.0 (1.23x) | 47.6 (1.89x) | 44.2 (1.75x) |
| projects-sidebar-flow 1280 (60s cap) | 33.9        | 45.4 (1.34x) | 52.7 (1.55x) | 42.5 (1.25x) | 60.0 (1.77x) | 58.3 (1.72x) |
| sidebar-agent-tree direct            | 23.4        | 31.3 (1.34x) | 39.4 (1.68x) | 28.1 (1.20x) | 46.6 (1.99x) | 41.2 (1.76x) |
| folder-controls 390                  | 22.4        | 24.3 (1.08x) | 31.7 (1.42x) | 27.9 (1.25x) | 36.2 (1.62x) | 29.9 (1.33x) |
| folder-controls 1280 (90s cap)       | 59.0        | 78 (1.32x)   | timeout      | 72 (1.22x)   | timeout      | timeout      |
| median slowdown, other cases         | 1.00x       | 1.32x        | 1.55x        | 1.20x        | 1.77x        | 1.72x        |

A uniform cohort-wide factor of 1.5-1.8x is runner CPU throughput (host
variance under 2:1 oversubscription), not one slow step: H4 (pathological
waits) and the data-growth variant of H3 are excluded because the API is fully
route-mocked and every step scaled by the same factor. The folder desktop case
had 59s of body at the fastest runner against a 90s deadline, so any runner

> =1.53x slower exhausts it; `projects-sidebar-flow` at 1280px (60s cap, 33.9s
> best) is the next sibling and hit 60.0s in attempt 1.

**Local reproduction (fails before the fix).** Lean worktree of origin/main,
production targets, the full UI cohort with four workers, emulating the slow
two-vCPU runner on this 8-core Xeon:

- `taskset -c 7` (one core), 4 workers, profiler on: the 1280px case timed out
  at 90s after 125 of ~200 actions (first hover 19.3s); `projects-sidebar-flow`
  1280px timed out at its 60s budget too; 34 passed, 2 failed, wall 311s.
  The Node worker's schedstat was run 1.44s / wait 8.69s (same 6:1 signature
  as CI).
- `taskset -c 7`, 2 workers, profiler on: the 1280px case still timed out
  (193 actions in 92.8s, post-reload hover 10.8s); one core is harsher than two
  half-speed vCPUs because driver round trips and rendering cannot overlap.
- cgroup scope `AllowedCPUs=5,6 CPUQuota=100%` (two schedulable CPUs sharing one
  core of time, the faithful emulation of two slow vCPUs), 4 workers, profiler
  on: the 1280px case timed out (1.5m), `projects-sidebar-flow` 1280px failed, and ten more cases failed; the scope used 354.7 CPU-s in 355.6s of wall and was throttled in 3538 of 3556 periods, i.e. the four-worker cohort was CPU-bound for its whole run. This emulation is harsher than the red runner (CI lost one case), so it bounds the mechanism rather than reproducing the exact CI margin; S1 and R3 ran concurrently on disjoint cores and shared the worktree output directory, so only their outcome lines, not their artifacts, are cited.

**Profiler overhead (H2), isolated.** Same spec alone, 1 worker, one core:
1280px body 35.5s with the CDP timeline + V8 CPU profiler fixture
(`SEMANTIC_FOLDER_PROFILE=1`, the CI default since 8a61c9d63) versus 25.3s
without it; node CPU 13.5s versus 10.7s for the file. Under the one-core
four-worker cohort: the same one-core four-worker cohort with the profiler off (`SEMANTIC_FOLDER_PROFILE=0`) still timed out the 1280px case (1.6m reported, versus 1.7m with it) and `projects-sidebar-flow` 1280px, so under that oversubscription the profiler is a contributor, not the deciding cost; the worker count is. The fixture doc claimed it "never changes
the scenario, assertion or test deadline"; it changed the headroom.

**Classification.** Our bug, problem class concurrency-inefficiency: fixed
worker count exceeding the runner's CPUs, with the diagnostics fixture
spending part of the remaining budget. The product-side cost of the desktop
reveal (the owner's `useLoginDarkMode` transition finding) is real but
unchanged between green and red runs and is not required to explain them.

**Archive.** Searches: "Test timeout of 90000ms exceeded playwright semantic
workers cpu" and "renderer starvation four Chromium workers oversubscribed
runner slow". This is a relative of
2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget (same class; its
capacity sizing was scoped to local mode) and supersedes the open incoming
hypothesis in 2026-10-31-project-folder-controls-serialized-driver-budget,
whose one-CPU affinity reproduction pointed at the same mechanism.

## Solution

1. `front-end/scripts/run-semantic-tests.sh` sizes Playwright workers from
   measured capacity in production mode as well as local mode.
   `semantic_workers_for_capacity` now caps at the CPU count even when no load
   is supplied; production mode passes no load (the post-install load on a
   dedicated runner is transient and must not serialize the gate) and keeps
   the free-memory floor. The CPU probe reports the schedulable affinity mask
   (`os.sched_getaffinity`) rather than `os.cpu_count()`, so cpusets and
   container masks count. The workflow's `SEMANTIC_WORKERS: 4` is now the
   ceiling: on the two-vCPU private-repository runner the gate runs two
   workers (`Semantic workers: requested=4 effective=2 (mode=prod cpus=2 ...)`
   is logged), on a four-vCPU runner it keeps four. Sibling prevented:
   `projects-sidebar-flow` at 1280px (60s cap) hit 60.0s in the same red run.
2. `front-end/tests-e2e/folder-profile.ts` makes the CDP timeline + V8 CPU
   profiler opt-in (`SEMANTIC_FOLDER_PROFILE=1`) instead of a CI default; the
   workflow does not set it. The owner's diagnostics remain available on demand.
3. `scripts/tests/semantic-deploy-gate.test.sh` (deploy structural gate
   `semantic-deploy`) cements both: the prod-mode sizing branch, the sizing
   block not being fenced to local mode again, `semantic_workers_for_capacity
4 2 '' 60 = 2` / `4 4 '' 60 = 4` / `4 1 '' 60 = 1` / `4 2 '' 10 = 1`, the
   opt-in fixture line, and the workflow never enabling the profiler. Against
   the original runner the test fails with `FAIL: a two-vCPU dedicated runner
must cap semantic workers at two`; against the fixed runner it passes.

Verification under the faithful slow-runner emulation (cgroup scope
`AllowedCPUs=5,6 CPUQuota=100%`, full production UI cohort, exact
`run-semantic-tests.sh --prod` with `SEMANTIC_WORKERS=4`, profiler unset):
the runner logged `Semantic workers: requested=4 effective=2 (mode=prod cpus=2 ...)`, all 36 UI cases passed (6 intentional exclusions), the 1280px folder case took 57.2s (33s of headroom), `projects-sidebar-flow` 1280px 38.4s, total wall 5.0 min against 5.9 min for the failing four-worker run under the same quota, and the scope used 298.5 CPU-s (versus 354.7 with four workers and the profiler).

Attribution under the same emulation with two workers but the profiler on
(`SEMANTIC_FOLDER_PROFILE=1`): the 1280px case passed with a body of 78.5s
(receipt `wallMs`, finalizer 9.6s, Node schedstat wait 36.3s / run 1.9s)
against 57.2s with it off, so worker sizing alone restores a pass at the
margin deploy 10 saw (80.2s body) and the opt-in profiler is what returns
real headroom. Both halves are therefore part of the fix.

No deadline, assertion, retry, benchmark definition or product behavior
changed. The gate's wall clock grows with two workers; its CPU demand does
not, so a two-vCPU runner finishes in about the same time with half the
per-test latency. This is a harness-only change with no runtime impact.

Open, not fixed here: the desktop reveal's product cost (the owner's
`useLoginDarkMode` transition finding and draft PR #1654) still makes the
1280px case the longest in the cohort; trace + video are recorded for every
test (`retain-on-failure`) and cost an ffmpeg encoder per worker; the runner's
exact vCPU count is documented (2 for private repositories) but not yet
recorded by the gate itself.

## Human feedback

The deploy coordinator required: no raising of the 90s budget, no weakened
assertion, a local reproduction that fails before and passes after the fix,
TMPDIR under /var/tmp, no pushes or PRs, and no edits to other worktrees. The
folders owner (PR #1651) asked that the route-mocked fixture rule out data
growth as a cause, that "partial profile" classification stay separate from
retry attempts, and that the profiling fixture's overhead be measured before
choosing a fix; all three are reflected above. Nothing was rejected.

## Reusable lesson

Never launch more Playwright workers than the CPUs the runner can actually schedule; size the production gate from measured capacity exactly as the local gate does, and treat a cohort-wide uniform slowdown as oversubscription rather than a single slow test.
