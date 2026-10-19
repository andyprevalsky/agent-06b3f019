---
id: 2026-10-18-fixed-clone-attempt-cap-charged-preallocation-donor-rate-limits
date: 2026-10-18
title: Fixed five-attempt clone cap was spent on allocation-free donor GET rate limits during a 600-copy burst
surface: infra
component: cloudbench-fleet-clone-retry
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet clone_machine_target charged a classifier-proven pre-allocation provider throttle against the fixed ambiguous-failure attempt cap
symptoms:
  - "Error: could not get machine 8ed16dc75ee958: failed to get VM 8ed16dc75ee958: resource_exhausted: rate limit exceeded"
  - "❌ Fly clone did not return a distinct authoritative target after 5 attempt(s)"
  - "⏳ transient clone failure (attempt 4/5, status=1); retrying in 68s ..."
  - "provisioning failed (no machine) — skipping"
tags:
  - cloudbench
  - fly-io
  - clone
  - rate-limit
  - preallocation
  - sharded-controllers
  - run600c
sources:
  - benchmark run run600c shard-10 r001-j0011
  - benchmark run run600c shard-13 r003-j0414
  - task polar-odysseys-24705fdf2d16
  - task polar-bu-090
  - commit a252045f5 (base of fix/clone-source-get-rate-limit)
repro: scripts/tests/cloudbench-clone-rate-response.test.py
status: fixed
---

## Problem

Run600c launched 600 REAL copies through 20 sharded disposable controllers, each
copy cloning its primary from the single donor Machine `8ed16dc75ee958` with a
snapshot fork. During the clone burst, 14 copies failed before allocation after
five attempts (8 s, 16 s, 34 s, 68 s backoff), each ending with
`Error: could not get machine 8ed16dc75ee958: failed to get VM 8ed16dc75ee958:
resource_exhausted: rate limit exceeded`, followed by `provisioning failed (no
machine)`. These were counted as infrastructure failures (14 of 600, below the
30 threshold).

## Diagnosis

`flyctl machine clone` first reads the source Machine. All 600 copies read the
same donor, so they exceeded Fly's per-Machine read limit. The existing
`clone_failure_definitively_unallocated` classifier already proved that every
attempt was allocation-free: one terminal error line for the exact source,
status 1 and no timeout. The name was then released as `not-allocated-verified`.
However, the retry loop charged that proven throttle against the same fixed
`CLOUDBENCH_CLONE_MAX_ATTEMPTS=5` cap used for ambiguous failures. Five attempts
covered roughly 126 s of backoff. That was shorter than the time the donor's
read limit needed to drain 600 near-simultaneous reads, so a few unlucky copies
exhausted their cap while the burst was still draining. Per-host campaign
mutation backoff coordinates only the 30 copies on one controller, not all 20
controllers. This is a relative of the 2026-07-15 clone-burst cases: their fix
(exponential backoff over five attempts) assumed the burst would end within a
fixed attempt count, but at sharded width it does not.

The local reproduction loaded the production `clone_machine_target` into the
existing source-read fixture. It returned the captured source-read throttle (and
HTTP 429 and target-volume-throttle variants) seven consecutive times before a
successful clone. On the base revision it failed with the same message: `did
not return a distinct authoritative target after 5 attempt(s)`.

## Solution

`clone_machine_target` now treats an attempt as uncharged only when the existing
single-error classifier proves that no allocation occurred, no owned target
volume was recovered, and that one terminal error line is itself an actual
throttle (`resource_exhausted` or a 429 status, with the opaque Request ID
removed). Such attempts retry with clamped exponential backoff, using wider
jitter of up to half the capped delay. They are bounded by
`CLOUDBENCH_CLONE_RATE_LIMIT_WINDOW_SECONDS` (default 600 s from the first
attempt), and sleeps are clamped to the remaining window. When the window is
exhausted, the function fails closed with an explicit message. Ambiguous,
timed-out, multi-error, volume-owning and ordinary failures keep the existing
five-attempt cap and authoritative name reconciliation. As a result, an
allocated clone can never be duplicated. The 600 s window fits inside the 900 s
fleet-readiness target and the original whole-run deadline, which strict
campaign pacing still enforces on every attempt. Rate-response detection now
uses here-strings, so a pipefail SIGPIPE cannot misclassify a real throttle.

Load behavior: each attempt makes one source read. With N waiting copies, the
offered donor read rate is about N divided by the mean retry delay. At the cap
this is about 600/115 s, or roughly 5 per second, and it falls as copies
succeed. Work per copy is O(1), with no new shared state. The single-donor read
remains an O(copies) hotspot. At 10,000 copies, the donor's read limit alone
would exceed the window, so that scale needs per-shard donors or a
Machines API create that does not read the source.

## Human feedback

None recorded.

## Reusable lesson

When the provider proves that a retry was rejected before allocation by a rate
limit, bound it by elapsed time rather than a fixed attempt count. The burst
duration grows with fan-out width, while a fixed count does not.
