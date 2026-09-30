---
id: 2026-09-30-large-cloud-archive-snapshot-read-burst
date: 2026-09-30
title: A large paused cloud tree timed out before publishing its archive snapshot
surface: infra
component: cloud-archive-snapshot-io
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/benchmarks/run_benchmark.py _refresh_browser_archive_snapshot launched unbounded full-transcript reads and recorded no phase until every read completed
symptoms:
  - "Cloud evidence finalization failed: TimeoutError"
  - "archive: TimeoutError"
tags:
  - cloud-fleet
  - archive
  - concurrency
sources:
  - PR #1299
  - fleet run 20260930-135320-4167
  - agent 70a3592f-c3c6-47b0-892b-31274d9c1749
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_large_archive_tree_does_not_overload_snapshot_reads
status: mitigated
---

## Problem

Proof74's unchanged mass-agent smoke evaluated after 339 seconds, then failed
archive finalization. Its exact root contains 51 agents and no browser sessions.
No slice credit is granted. The proof was canceled after 19m31s, before the
independent 30-minute E2E cutoff, and its original bytes were preserved.

## Diagnosis

The original result records `archive: TimeoutError` and no completed
`browser_archive_observation`. Original snapshots contain no browser task
metadata. This separates the incident from missing recording attachment. Its
disconnected DELETE subsequently completed the exact 51-agent fence and verified
provider/payment retirement; the previous deletion-fence fix held.
Backend logs contain 14 aborted message requests and one transaction that ran
10,076 ms against its existing 10,000 ms bound. These establish runtime pressure,
not causality for a specific archive request. The archive function launches all
full-transcript reads concurrently and records its observation only after every
read returns. The precise failing read is an observability gap: tree-fetch and
snapshot-fetch time were not distinguished. Do not report that gap as a proved
live backend root cause.

Archive searches used `Invalid control character run.json`,
`truncated streamed result runtime capture`, and the literal archive timeout
through repository search. The earlier archive-before-recording case is related,
but this task has no allocated browser and owed no fabricated recording.

## Solution

Bound full-transcript reads to eight concurrent slots per paused tree and retain
all 51 snapshots, the original archive deadline and all readiness checks.
Record phase, expected IDs and completed IDs before a failed read can erase its
location. This is a containment of a demonstrated unbounded-I/O boundary,
pending unchanged live verification; it does not claim the production pressure
mechanism is fully diagnosed. No LLM scheduling, task trajectory or scoring is
changed, and no timeout is relaxed.

The permanent capacity-boundary reproduction executes the real archive routine:
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloud_batch_cleanup_test.py -k large_archive_tree`.
With the original unbounded burst it expires the same fixed test deadline.
With bounded reads the unchanged test collects every original transcript under
that deadline. All 30 cleanup cases pass, including failed readiness, incomplete
tree and cleanup authority refusals. These cases are auto-discovered by the
owning benchmark blackbox suite. The capacity fixture is causal evidence for the
burst behavior, not proof of an unchanged live benchmark result. A live rerun
must establish archive success; a repeated timeout must be investigated using
the newly preserved exact phase rather than merely retried.

## Recurrence on 2026-09-30

Proof75 on `030678c366ae5ac648e61148b554f23a4c8eb2d5` reproduced the archive
failure on the unchanged mass smoke. Its observation now identifies
`agent_snapshots`: 48 of 51 expected IDs completed before the existing 60-second
bound. The native guest was shared-cpu-2x/4 GB; transcript HTTP responses took
roughly 1–2 seconds, but successive read groups were several seconds farther
apart. A quiescent client-construction probe took about 0.03–0.04 CPU seconds
per warm client, which alone does not establish the live delay. Host quota
metrics were inaccessible with the available token. Do not call the CPU
hypothesis proved from these observations.

Bounded fanout did not resolve the live outcome; its phase capture held and
narrows the investigation. The exact deletion fence and provider retirement
again verified. Nine other benches returned real evaluations with 5–60
correlated successful LLM responses each. Proof75 remains zero slice credit;
all original failed bytes were preserved and exact-owner retirement completed.
A controlled dedicated-CPU comparison preserves the same task plan, prompts,
models, evaluators, deadlines and evidence gates. It also exposed the separate
shared-only pool admission defect recorded in
`2026-09-30-pool-cpu-kind-validation-assumed-shared`.

## Proof77 boundary observation

Proof77 on a1363effb exercised the dedicated CPU profile: all ten tasks emitted
ordinary FAILED results and verified guest/provider retirement. Mass-agent
finished its task/archive boundary in 308 seconds without the prior archive
timeout. This is a successful boundary observation, not proof that shared CPU
quota alone caused proof75's timeout. The campaign still earned zero credit:
mass-agent's intentional cache replay had no live queries, contradicting this
proof's three-live-completion requirement. See the separate zero-spend admission
case; nine other tasks had 14–70 correlated live completions.

## Human feedback

Inspect runtime issues that disguise infrastructure failures, check concurrency
slowdowns, keep five-minute task backstops for this proof, and retain the
independent 30-minute E2E cutoff. Benchmark FAILURE may remain FAILURE.

## Reusable lesson

Bound archive read fanout and preserve the exact unfinished phase before the
archive deadline expires.
