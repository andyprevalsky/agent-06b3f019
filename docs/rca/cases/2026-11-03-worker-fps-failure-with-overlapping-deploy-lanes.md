---
id: 2026-11-03-worker-fps-failure-with-overlapping-deploy-lanes
date: 2026-11-03
title: rose-ui check judged a CPU-starved particles-worker as jank because its host-busy signal was the lagging 1-minute load average
surface: harness
component: backend-browser-fps-probe
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/assets/user-ui/bin/rose-ui.cjs evaluateBudgets decided whether the host could judge fps from os.loadavg()[0] sampled before each entry, which lags a host that just became busy, instead of contention measured during the fps windows
symptoms:
  - "particles-worker: fps-p50 value 30, minimum 55"
  - check --examples passes every shipped example
  - "worker 1 p50 30 fps (min 55)"
  - new-test-stability occurrence 4e2eb84f5fdf415d9da6ce9e54b04f8d
  - "fps-inconclusive host oversubscribed"
tags:
  - fps
  - chromium
  - contention
  - observability
  - load-average
  - new-test-stability
sources:
  - PR #1664
  - commit 61c3f876ee37d6b52a29c6d870d9459a90a33307
  - PR #1915
  - commit 72186aa4dc98bb4c519b745f8482af747030936c
repro: back-end/src/tests/unit/rose-ui-fps-host-contention.test.ts
status: fixed
---

## Problem

The first full backend coverage attempt passed all 356 ordinary unit files,
then the separate browser probe passed five of six tests and failed the shipped
examples check. particles-worker reported p50 30fps below 55 and p5 20fps below
30, with worst frame 100ms. This was an FPS verdict, not a timeout. The native
probe duration was 121.589s, approximately 04:22:09–04:24:10 UTC November 3.

## Diagnosis

Backend product and test source were unchanged from main. Independent local
semantic/build work and native controller fixtures overlapped the probe. Four
semantic browser workers ran on eight CPUs; host load1 rose from 2.31 at probe
start to 15.38 at failure. These observations do not establish which process
caused renderer delay or exclude example defects or nondeterminism. No causal
per-frame scheduler trace was captured.

Searches for particles-worker/fps-p50/fps-p5 and host contention found no exact
case. The October 26 rose-ui-long-task-judged-host-inflated-wall-time case is
related: its first bad boundary was long-task wall-time evaluation, whereas
this incident fails frame-rate budgets. Its fixed status is unchanged. This
case stays open until controlled causal proof establishes the producer.

## Solution

No speculative product patch or threshold relaxation was made. The existing
full failed-first backend retry preserved both shards, all unit files, the
late browser probe, merged coverage thresholds and teardown. Other healthy
lanes finished before the late probe; timestamped process/load observations
were retained. The terminal native outcome belongs in the deploy receipts.
An observed passing unchanged retry establishes that execution's pass, not a
contention fix or deterministic causal RCA. Retain the first failed probe and
its source, clock bounds and native metrics even if a later invocation passes.

Private artifacts under mobile-pwa-fixture-repair preserve backend-first-attempt,
probe-resource-observations.jsonl, the independent gate review, and full retry
logs. Golden reference and 10k-agent runtime impact: not applicable; no runtime
code was changed. The missing causal trace remains explicit rather than being
reported as fixed by a green retry.

## Human feedback

The user required actual backend, local semantic and remaining gate outcomes,
with original failures and bounds preserved. The capacity error during the
parent turn was a provider failure, not a test outcome or task completion.

## Reusable lesson

Judge whether a host can fairly measure a performance budget from contention measured during the measured window itself, never from a lagging average sampled before it.


## 2026-11-09 PR1708 FULL39 recurrence observation (OPEN)

Occurrence524549e9ada4471faa6ec9b00874b4c4 on frozen3b620627f572e968402ff9768460611db6aa52a3
failed the original check --examples assertion: only particles-worker worker1
p50=30 below unchanged55. Six tests ran, five passed, native exit1. The original
units-probe.log was preserved byte-for-byte (SHA256 a601e5a240b22e6023370a9955cfeedd48b82bbab77b3300127f9e183b73d00e),
along with host-pressure and server logs. Original scratch /tmp/rose-ui-smoke-dw4so9,
examples-check.json and runner.log were already absent. Host load snapshots
alone are not a causal diagnosis. This matches the old symptom, not a proven
recurrence of an established underlying cause.

Frozen UI/CLI/worker/example/test closure is identical on3b6206, ce016 and main6b505.
Actual retained worker files match the frozen copy. Prior FULL36 ce016 receipt
records fpsPASS/native0. Source equality and prior success do not prove NI.
A private focused current-source replay ran the unchanged examples assertion:
it exited0 but workers still measured30/20 FPS, and existing host-busy logic
reported fps-inconclusive (loadPerCore1.63, blank/main60). This is not a repaired
performance result. A full original six-test Node invocation on frozen main6b505,
with private V8 coverage, passed all6 including deliberately-janky and blocking-
GPU negative controls. Its particles worker measured60/30 (mean38.7), so it did
not reproduce the original failing assertion. Gate UNKNOWN remains.

A bounded follow-up ran the existing current CLI for the particles entry with
an observer that only retained its existing trace and worker-snapshot outputs;
no browser flags, rendering code, evaluator or timing values changed. Both
worker windows had median33.3ms callback spacing, while main/blank were60FPS.
The selected worker result was30/30. Animation callbacks had median1.663ms wall
and total121.274ms CPU over75 traced callbacks. Separate RunMicrotasks events
reached58.133ms wall/10.227ms CPU, and GPU-main tasks reached31.924ms wall/1.493ms
CPU. These are new-run observations, not proof of the original cause. They do
not yet distinguish compositor/GPU waiting, worker microtasks or descheduling.
The worker remained offscreen-webgl2 with9309 particles, with no page errors;
hidden and reduced-motion controls remained intact.

No product patch is proposed without a causal FAIL->fix->PASS proof. No full254
backend rerun, DB change, provider operation, new review or mutation of the healthy
FULL39 siblings occurred. The original failure stays recorded and blocking.
The next investigation uses the retained trace at the worker-rAF delivery and
microtask/GPU boundary and must obtain a strict failing window with original
thresholds before attributing or fixing it. All commands, timings, hashes and
limitations are in backend-fps-rca-0034/child/result.json.


## 2026-11-09 lifecycle continuation (OPEN)

# FPS lifecycle continuation — OPEN, Gate UNKNOWN

The original FULL39 failure remains native1: worker p50=30 below the unchanged55. Its raw unit log SHA256 is `a601e5a240b22e6023370a9955cfeedd48b82bbab77b3300127f9e183b73d00e`. Initial findings and raw traces were preserved before this continuation. No fix is proposed and no gate is waived.

Four serialized original CLI lifecycle controls gave baseline/guard/baseline/guard worker p50=60 and p5=30, with means44.0/45.5/46.4/44.4. Exactly one same-size1280x800 resize followed init; run(true) finished around85ms, before samples began around1081ms. Matching Chromium156 SetSize already returns for equal-size WebGL canvases. This does not support a resize fix.

The richer unchanged-example trace binds actual HeadlessChrome156.0.8078.4 revision f842f52ef39fd97b449eb27cff414bf05a98ddce. Its worker callback median is1.632ms; GetResourceForPushFrame is17.06ms (CPU7.522ms), and GLES2::ReadPixels11.857ms (CPU2.5445ms). PushFrame itself is0.098ms. The time is predominantly before PushFrame in native resource export, not all inside JavaScript simulation/drawing. The original earlier30/30 warning trace separately shows median23.188ms post-callback microtask tails; this is a later reproduction, not the original failure capture.

Of122 traced worker provider microtasks,92 enter ExecuteFrameCallbacks/FireAnimationFrame/export/push;30 enter none of those. Exact tagged provider code permits only AddOffscreenCanvas rejection between this trace start and callback collection, and that rejection checks pending frames. This supports an engine-source-bound inference of new-run pending-frame backpressure. It does not identify why pending acknowledgements accumulate: the trace has no ack/pending-depth data. The rich trace itself passes60/30 and therefore cannot establish the original30 failure's cause.

A private gl.finish diagnostic preserved the workload and visual instructions but neither improved cadence nor removed the export tail: original and diagnostic both91frames,60/30,mean45; export17.06 vs17.378ms. Neither this diagnostic nor the resize variant is a candidate patch.

The parent-requested final exact six-test main6b505 native control completed exit0 in 121.232s: {'tests': 6, 'pass': 6, 'fail': 0, 'cancelled': 0, 'skipped': 0}. Its actual particle metrics, negative-control results and warnings are in result.json and main-final-control/output/examples-check.json. Passing main remains insufficient to claim NI. Original source/CLI/runtime closure matrices remain preserved. No repeated full254 backend gate ran.

The next discriminating boundary is ReadPixels command-service completion versus compositor frame acknowledgement, using the same browser options and actual GPU compositing status. No thresholds, sample duration, budgets, concurrency, browser flags, warmups, heartbeat, CPU load or inconclusive logic may change. A naturally strict failing window plus an intervention that preserves rendering and passes unchanged55 is still required before a fix or permanent regression can be claimed.

All native command arrays, start/end epochs and exits are in runs.json and each engine/main receipt. The process observation at completion is []. No canonical, provider, worker, DB, service, review or Freedom changes were made. Model/effort/speed remain unexposed. The title prefix was verified unchanged.


## Independent window-selection replay (original remains OPEN)

# Independent FPS window selector defect — private candidate

Original FULL39 Gate: UNKNOWN. The original p50=30/min55 failure remains unchanged; its frame vectors were not retained. This candidate fixes a separately reproduced sampler-owner defect and is not proof of the original cause, physical rendering improvement, or a passing deployment gate.

The original measureRoute promises the better of two existing windows but compares only p5. Replaying real later captured vectors30/30 then60/30 through that actual function retains30/30 and fails the exact unchanged evaluateBudgets p50>=55 assertion. The same caller replay fails on frozen3b620627 and main6b505. The private fix adds p50 as the tie-break when p5 is equal, reusing it for main and worker selection. It does not alter any budget, evaluator, assertion, window, timeout, flags, rendering code or number of samples.

Valid before command: `['node', '--import', 'tsx', 'src/tests/unit/rose-ui-fps-window-selection.test.ts']`, exit1; two positive cases FAIL and both negative controls PASS. Identical after command exit0; all4PASS. Main-source replay exit1. The two-slow-windows test still rejects p50, and improved FPS does not erase a first-window long-task violation. Native --list confirms the new *.test.ts is registered in the owning unit runner. The list-only resolver used an unused explicit local URL and never contacted a DB.

The real-vector fixture is a constructed pair from different later diagnostic runs, with exact source paths/hashes in result.json. It is NOT the lost native original pair. The statement that both captured windows were30/30 refers only to child/traces/worker-windows.jsonl, never FULL39.

The unchanged original six-test native Node entrypoint on the candidate completed exit0 in 113.587s: {'tests': 6, 'pass': 6, 'fail': 0, 'cancelled': 0, 'skipped': 0}. The original browser-test source hash remains7e67ba6ca0dbf85ae38363115ad92b3a1fd132621580df669ca2f95da67f91d4. All actual janky/GPU negative results and particle metrics are retained under native-after. These six tests are targeted compatibility evidence, not whole-gate or original-RCA completion credit.

Patch SHA256 `7b8b36af185b7d3ccafad5c61ca0d0b30cc781fe3712c59e276d1fdabf8f138e`. Review/integration belongs to the parent. All owned processes at handoff: []. No canonical state changed.


## Review counterexamples R1/R2 and private repair

# Sampler R1/R2 repair candidate

Original FULL39 Gate: UNKNOWN. Its native FPS failure remains unchanged. Historical7b8b patch/result/native-six evidence remains byte-preserved under sampler-0103. This is a new private repair of its two independently demonstrated P2 defects.

R1: the previous comparator accepted a five-frame60/30 retry over a judged73-frame30/30 failure. The unchanged evaluator then skipped the undersampled result. The comparator now accepts only >=10-frame finitep50/p5 candidates, and keeps first evidence otherwise. The minimum and all evaluator logic remain unchanged.

R2: workerSnaps.filter(Boolean) erased the originating positions before index-based comparison. WorkerA missing on retry caused healthyB to replaceA. The unchanged openHost registry is append-only; capture now attaches that numeric registry index before filtering. The retry joins measurements by that index. Missing, reordered or unidentifiable snapshots cannot replace a different worker. Internal indices are stripped from the public metric objects; no worker object is serialized.

The final registered regression runs actual measureWindow,workerCall,measureRoute,frameStats,evaluateBudgets with browser IO doubles and retained real vectors. Before:{'tests': 13, 'pass': 8, 'fail': 5, 'cancelled': 0, 'skipped': 0}; after:{'tests': 13, 'pass': 13, 'fail': 0, 'cancelled': 0, 'skipped': 0}. It covers valid tied-p5 improvement, worker/main undersampling, exactly10 frames, nonfinite data, missing retry/first worker, reordered snapshots, bothslow and first-windowlongtask. Exact copied reviewer counterexamples also change from falsePASS to preservedFAIL. Their legacy mocks omit the new identity field; the registered suite additionally validates the real capture contract and valid same-worker improvement.

All12 existing budget tests passed. Native unchanged six-browser-test command exit0, counts{'tests': 6, 'pass': 6, 'fail': 0, 'cancelled': 0, 'skipped': 0}, duration114.452s. Deliberatelyjanky and blockingGPU controls remain in that unmodified suite. Native FPS windows and raw result are retained and give integration evidence only, not original causality or performance improvement. The original browser test, frameStats,evaluateBudgets,budgets,worker probe and traced-window function hashes are unchanged.

Frozen patch SHA256:7264e06ccde59be3882e7206c8f69275cf469d35ea13f8e8e9434f4fe82c900d. Same independent reviewer ph7dy was asked for R1/R2 recheck only after this hash froze; the independent recheck is P2_CLEAR on this exact patch and its result remains separately recorded. Parent owns integration and all full source gates. No canonical environment,provider,DB,service,review ledger,worker orFreedom state changed. All own processes at handoff:[].


## 2026-11-11 new-test-stability recurrence: causal proof and fix (FIXED)

Occurrence 4e2eb84f5fdf415d9da6ce9e54b04f8d: the new-test-stability gate (GitHub Actions
run 43005917253, source d986931533, 8 vCPU) reran this unit 5 times with every CPU held
by load slots (concurrent units plus busy CPU workers). Run 2 failed the unchanged
assertion: `particles-worker: [{"rule":"fps-p50","message":"worker 1 p50 30 fps (min 55)","value":30,"limit":55}]`.
PR #1915 quarantined the test (`pending-handoff:4e2eb84f…`); this repair removes that marker.

Causal proof (local, 8 CPUs, unquarantined test, harness `.context/rose-ui-fps-rca/repro.sh`
swapping only the CLI file):

- Unchanged CLI, 7 steady busy loops: 3/3 pass, worker 60/30 (load/core 0.57-0.98).
- Unchanged CLI, 12 steady loops: worker 60/20; the existing guard fires (load/core
  1.26-1.66), so the result is `fps-inconclusive`, not a failure.
- Unchanged CLI, 16 busy loops started at the same moment as the check (1-minute load
  average under 1.5 beforehand): 2/2 FAIL, exactly `worker 1 p50 30 fps (min 55)`, with
  `host.loadPerCore` 0.97 and 0.99 and a 60 fps blank baseline. The only variable
  changed between pass and fail is external CPU load, so starvation by other processes
  causes the 30 fps worker.
- Fixed CLI, same cold-burst protocol: 7/7 pass (2 on the first candidate, 5 on the
  final CLI). The worker is still starved to 30/20 every time, with load/core 0.91-1.08.
  Measured in-window shares are other=0.83-0.89 in every window, so the result is
  `fps-inconclusive` and the test passes.
- Fixed CLI, 7 steady loops: other=0.77-0.78, worker 60/30. The budget was met, so
  fps is judged and passes with no warning.
- Fixed CLI, quiet host, full unchanged browser file: 7/7 pass, including the
  deliberately janky and blocking-GPU negative controls. particles-worker is judged
  at 60/60 with other=0.025, and no example has an inconclusive warning.

First bad boundary: `evaluateBudgets` decided whether the host was fit to judge fps
from `os.loadavg()[0]`, sampled once before each entry. The 1-minute average is an
exponentially weighted value that lags a host that has just become busy. The
stability gate starts and stops units and load workers beside the check, so the
host can be oversubscribed while that average still reads at most 1.25 per core.
The blank-page baseline does not catch this either: it runs once and only on the
main thread, while the starved workload is an OffscreenCanvas WebGL worker on
software GL (SwiftShader). That worker needs CPU on several threads and processes
for every frame.

Deepest owned cause: the checker's contract is "fps is judged only when the host
can render fairly", but its signal for that was measured at a different time from
the fps windows. It used a smoothed history, not what happened during those windows.

Fix (`back-end/src/assets/user-ui/bin/rose-ui.cjs`):

- `hostCpuSample()` reads `/proc/stat` busy/total ticks. It also reads the CPU ticks
  (utime+stime+cutime+cstime) of the check's whole process tree, found by a ppid scan,
  so reaped children stay counted.
- `hostCpuShare()` turns two samples into `{other, own, idle}`.
- `measureRoute` records `normal.hostCpu` for every fps window.
- `evaluateBudgets` adds a busy condition: every fps window the verdict could use had
  other processes above 50% of the host's CPU. The 1.25 load-average rule and the
  blank-page rule are unchanged.

It fails closed in four cases, and fps is then judged:

- no `/proc`;
- this process missing from `/proc` (another PID namespace);
- the own-tree ticks went backwards (a tree process reaped outside the tree);
- any window without a share.

Budgets (p50 55, p5 30), window count and other rules are unchanged. Long-task,
hidden-loop, reduced-motion, layout and bytes rules are still judged on a busy host.

Policy, stated plainly (adversarial review finding 1): the 50% rule does not detect
starvation itself. A healthy page can still reach 60 fps with 7 of 8 CPUs busy on an
uncontended VM. The rule declares a host with more than half its CPU taken by others
unfit to judge fps, whatever the page manages. `performance.md` tells agents this, and
the warning tells them to re-run on a quiet host. A quiet host is still judged.

Known limits, left open:

- The share is an average over each window, so a short burst that starts mid-window
  can still lower p5.
- Kernel work the page causes (softirq, reclaim) counts as other.
- A cgroup CPU quota throttling the check itself is not detected.
- PSI (`/proc/pressure/cpu`) is absent on the devbox kernel and was not used.

Regressions:

- `rose-ui-fps-host-contention.test.ts`: the verdict on contended, mixed, quiet and
  missing windows; tree attribution against a fake /proc, including reaped children
  and process names with spaces and parentheses; the fail-closed cases.
- `rose-ui-fps-window-selection.test.ts`: the real `measureRoute`, with host counters
  injected, records one share per window and turns two contended slow windows into
  inconclusive. A quiet retry is still judged. Host IO is now pinned in this harness;
  it previously read the real host.
- The unquarantined `rose-ui-cli-browser.test.ts`.

All three new unit tests failed against the unchanged CLI and pass with the fix.
Golden reference and 10k-agent impact: none. This is a local developer CLI; it
samples /proc twice per fps window and has no runtime or agent fan-out.
