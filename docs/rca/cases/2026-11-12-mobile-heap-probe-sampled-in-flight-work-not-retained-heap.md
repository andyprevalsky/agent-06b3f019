---
id: 2026-11-12-mobile-heap-probe-sampled-in-flight-work-not-retained-heap
date: 2026-11-12
title: Mobile stress spec's "post-GC heap" read one collection at the instant after navigation, catching in-flight work and floating garbage instead of the retained heap
surface: front-end
component: tests-e2e-mobile-resource-monitor
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: front-end/tests-e2e/mobile-performance.ts mobileResourceMonitor snapshot() — one HeapProfiler.collectGarbage plus one Runtime.getHeapUsage, one rAF after the navigation's content appeared, was treated as the retained heap for the baseline and every round
symptoms:
  - "round-trip-3: post-GC heap"
  - "post-GC heap 57.3 MB > 54.9 MB bound (baseline.heapBytes * 1.2 + 4 MiB), passed on retry"
  - "mobile-long-trajectory.spec.ts › mobile long trajectories retain old content and bounded resources after repeated switch/back"
  - "semantic-stack ui lane FLAKY: expect.soft(sample.heapBytes).toBeLessThanOrEqual(baseline.heapBytes * 1.2 + 4 * 1024 * 1024)"
  - "heapBytes 42240720 | 44971724 | 45191404 | 57275628 | 57342296 | 45249680 | 45395404 with DOM nodes 16891 throughout"
tags:
  - semantic-gate
  - playwright
  - flaky-e2e
  - heap
  - memory
  - cdp
  - mobile
sources:
  - commit ca368f639
  - commit 8acf074d6
  - PR #1983
repro: front-end/src/tests/blackbox/mobile-heap-measurement.blackbox.ts
status: fixed
---

## Problem

The semantic-stack gate for PR #1983 failed once on unchanged main on
2026-11-12, then passed on retry. The failing soft assert was
`round-trip-3: post-GC heap` in `front-end/tests-e2e/mobile-long-trajectory.spec.ts`.
It compares `baseline.heapBytes * 1.2 + 4 MiB` against each round.

The failed attempt ran on Blacksmith 8vcpu, Chrome 158.0.8127.18, head 0e15e6917a.
Its per-sample heapBytes, as reported by the PR #1983 owner from
`mobile-resources.json`:

| Sample | heapBytes  |
| ------ | ---------- |
| warmed | 42,240,720 |
| rt1    | 44,971,724 |
| rt2    | 45,191,404 |
| rt3    | 57,275,628 |
| rt4    | 57,342,296 |
| rt5    | 45,249,680 |
| rt6    | 45,395,404 |

The bound was 54,883,168, so rt3 and rt4 failed. DOM nodes stayed at 16891 in
every sample. The retry spiked +6.4 MB at rt2, fell below its own baseline at
rt4, then rose to 51.9 MB.

Four in-flight deploys were exposed: PR #1975, d87e1d46, 495045f7 and PR #1983.
A Playwright spec cannot carry the in-definition FLAKY marker, so
`.claude/shared/deploy-failure-policy.md` offered no waiver.

Archive searches were run for "post-GC heap mobile long trajectory heapBytes soft
assert" and "heap growth flaky memory measurement playwright", plus a grep for
`post-GC|getHeapUsage|mobileResourceMonitor`. There was no prior heap-measurement
case, so this one is novel.

## Diagnosis

### Setup and critical path

All runs used the semantic gate's own bundle: `run.sh --benchmark` flags (`ROSE_E2E_FIXTURES=true`,
`VITE_ENABLE_REACT_GRAB=false`), served by `vite preview`. The fixture is 2
agents of 3,000 messages each, with a 2.1 MB agent-detail response that is
fetched on every selection. The spec selects an agent and waits for its last
message to be visible. `snapshot()` then waits one rAF, runs one
`HeapProfiler.collectGarbage` and reads `Runtime.getHeapUsage().usedSize`.

Scratch diagnostics were not committed. Their evidence is under `.context/heap-rca/`.

### Findings

1. **One collection is not settled.** A second `collectGarbage` with no page
   work in between freed another 0.7-3.7 MB (diag-1). Example: warmed 38.16 →
   34.49 MB. Reads were identical after that.
2. **The instant after navigation includes live, in-flight work.**
   - With prompt sampling, the gate's cadence, settled reads still spiked
     +3 to +5.4 MB in 9/48 round samples with the original probe and in 5/30
     with a GC-settled probe. Spikes fell back on a later round.
   - In v4, two such spikes survived an immediate V8 heap-profiler collection
     (`Runtime.queryObjects`, which collects all available garbage):
     41.3 → 44.6 MB and 43.3 → 42.4 MB. So that memory is reachable, not
     garbage.
   - In v5, every sample was re-read once a second for 12 s. Every series
     converged by the 1-2 s read and then stayed flat. The warmed sample dropped
     1.5-2.9 MB within its first second. No round spiked once the page had been
     idle after the previous sample.
   - The gate's own series has the same shape: rt3/rt4 +12 MB with the DOM node
     count unchanged, back to 45.2 MB at rt5.

   The memory belongs to work the app is still finishing after a navigation. It
   is held for seconds and released when the page goes idle. It is not retained
   per navigation. Its size and frequency depend on CPU speed and load, which is
   why the slower gate VM saw +12 MB while this 8-core devbox saw ≤5.5 MB.

3. **Main did not regress heap.** The A/B used identical builds and the settled
   probe, single worker:

   | Build                 | Warmed  | Steady (rounds 3-8) | Per-round growth |
   | --------------------- | ------- | ------------------- | ---------------- |
   | Pre-suspect d27550bc9 | 32.3 MB | 33.9-34.0 MB        | ~20 KB           |
   | Main 15e89bf4e        | 34.5 MB | 37.5-37.65 MB       | ~23 KB           |

   Neither build grows per navigation. Main's ~3.6 MB is a constant feature
   offset that the baseline-relative bound already absorbs. The pre-suspect
   bundle shows the same single-read excess, up to 5.5 MB. So the transient
   class predates the suspect commits (`9f388089e..d7e7dfe18`, `6fd6df597`,
   `1dca6e1ed`, `15e89bf4e`).

### Deepest owned cause

The resource probe defined "post-GC heap" as one collection at one instant,
immediately after a navigation. A leak assertion needs the retained heap of a
quiescent page. As implemented, the value had unbounded timing-dependent
variance on both the baseline and the samples.

## Solution

`front-end/tests-e2e/mobile-performance.ts` now reads the heap through
`retainedHeapBytes(cdp, idle)`:

1. **Settle each read.** Collect and read `usedSize` until a pass frees less
   than 256 KiB, for at most 8 passes. If it never settles, throw `post-GC heap
still shrinking`.
2. **Wait for quiescence.** Re-read after each 1 s of idle until two consecutive
   settled reads agree within 256 KiB, for at most 10 reads. If they never
   agree, throw `post-GC heap still changing`.

What stays unchanged, and why this is not looser:

- The baseline and every round use the same value.
- The spec, its `* 1.2 + 4 MiB` bound and every other assertion are unchanged.
- Reachable memory, such as a trajectory leaked per navigation, survives every
  pass and every interval, so it is measured in full.
- A heap that keeps growing while idle now fails loudly instead of passing by luck.
- The baseline drops (warmed 36.8-38.2 → 35.3 MB), so the effective bound is
  tighter.
- The sibling `mobile-adversarial-trajectories.spec.ts` "released heap" bound
  shares the monitor and gets the same fix. It passed 8/8.

Regression test: `front-end/src/tests/blackbox/mobile-heap-measurement.blackbox.ts`.
It runs in the deploy front-end coverage gate (`npm run test:coverage`, include
`src/tests/blackbox/**/*.blackbox.ts`) and replays the measured Chromium
sequences through a fake CDP session.

- On the pre-fix logic, all 6 cases fail, e.g. `expected 38160000 to be 34490000`,
  `expected 43310000 to be 38300000`.
- On the fix, all 6 pass. The cases cover floating garbage, in-flight work, a
  still-draining spike, a fully reported 57.3 MB retained heap, and the two
  loud failures.

Real-browser proof is the unchanged spec at the fixed source:

- `--workers=4 --repeat-each=8`, the configuration that spiked 9/48 round
  samples with the original probe: 8/8 passed, 0/48 spikes, rounds
  38.1-38.4 MB, minimum margin 8.26 MB (was 4.64 MB).
- 5 consecutive `--workers=1` runs: 5/5 passed, worst sample 38.39 MB,
  margins 8.24-10.02 MB.

A residual note: the warmed baseline settles on one of two stable levels,
35.3 or 36.8 MB. Rounds after the second hold at 38.1-38.4 MB, so this moves
the bound by about 1.7 MB inside an 8+ MB margin.

At 10k agents this is not affected: it is test-only code in one Playwright page,
with no runtime or bundle change.

## Human feedback

Andy (2026-11-12 goal): never raise the bound or loosen the assertion. If main
regressed, fix the real cause. If it is measurement noise, make the measurement
deterministic, with evidence.

## Reusable lesson

Measure a leak bound on the retained heap of a quiescent page: collect until a pass frees (almost) nothing, re-read after idle until two reads agree, use that same value for baseline and samples, and A/B that value before calling a heap flake a regression.
