---
id: 2026-10-27-native-guest-cpu-attribution-gap
date: 2026-10-27
title: Native guest diagnostics CPU assertion failed without burner ownership or raw tick provenance
surface: harness
component: cloudbench-guest-diagnostics
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Unknown upstream of native burner top8 CPU assertion; original burner PID and raw tick inputs were not retained
symptoms:
  - "assert burned and max(row['cpu_pct'] for row in burned) >= 50"
  - "test_runtime_collector_rechecks_terminal_seal_and_bounds_transport_reads[guest-diagnostics]"
tags:
  - cloudbench
  - guest-diagnostics
  - cpu-attribution
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - task deploy-native-guest-cpu-assertion
repro: scripts/tests/cloudbench-runtime-evidence-collector.test.py includes birth-fenced parser controls; original historical sample gap remains
status: open
---

## Problem

The original native owning assertion failed with two top8 sample payloads. Python PID3616732 showed42.1/47.3 percent, but the log does not bind that PID to the fixture burner.

## Diagnosis

OPEN. Sampler measures tick delta / HZ / monotonic elapsed. Original raw inputs and burner ownership are absent. Two local executions with diagnostic capture passed. Neither CPU allocation, readiness nor arithmetic failure has been proven. See `.context/cpu-sampler-rca-20261027/REPORT.md` and its exact native receipts. Archive CPU cases are related, not a proven recurrence.

## Solution

No runtime repair. Optional exact observer proposal preserves all50 assertion ASTs and deadlines while retaining PID/ticks/elapsed and pre-cleanup payload. The author observer native validation passed1test in1.66s. The applied bounded diagnostic additionally caps retained tick records at128 with a dropped count and registers its exit writer only when enabled; each burner gets a private PID-named subdirectory to avoid overwriting concurrent native invocations. The applied bounded observer passed the unchanged owning native pytest once in2.160s; this validates capture compatibility, not a repair. Fresh full acceptance is pending. Observer overhead remains unmeasured; causal-red and identical-command repair-green gates remain open.

## Human feedback

None recorded for this failure. The unchanged acceptance and evidence requirements come from repository guidance and coordinator instructions.

## Reusable lesson

Retain the owned burner identity and raw tick-denominator inputs before temporary fixture cleanup before attributing a CPU assertion failure.

## Recurrence on 2026-10-28

The940d agents benchmark domain again failed the unchanged native burner>=50 assertion. Its top8 included individual kernel workers at525.5/462.3 percent in one interval; the raw before counters and exact original burner row were not retained. This does not prove which original process changed identity or the burner's CPU share.

A separate exact arithmetic defect is now reproduced: the sampler treated a changed comm as an absent baseline and counted the process's entire lifetime ticks. The real /proc parser control uses PID123, birth77, ticks10000→10001, with a renamed comm: old code reports10001 percent at HZ100 instead of1 percent. Birth77→88 with reusedPID also must not inherit an interval baseline. Original same-input native owner fails the new parser assertion in0.264s; candidate passes in1.311s, including every49 preexisting collector assertion and the real burner101.2/98.8 percent, above the unchanged>=50 predicate.

The correction reads /proc/<pid>/stat field22 and compares ticks only for the same known PID birth. Comm rename no longer resets the tick baseline; unseen/reused lifetimes warm up one sample. Published row keys, aggregate CPU fields, sampling interval, maxsamples and all existing assertions stay unchanged. Three permanent parser/identity checks run inside the registered guest-diagnostics owner. Independent review verified field offsets14/15/22 and all old assertions. Exact patch472a151 and receipts are under`.context/deploy-fresh-20261027/rca-cpu-attribution-940d/`.

The optional diagnostic tail also now retains the newest128 samples with cumulative evictions instead of retaining the first128 forever. Its same129-sample control fails before and passes after; normal runtime output is unaffected. This improves future evidence rather than proving the historical first failure. No provider, DB or model request was made; the native owner uses its existing fake psql and joins its owned burner.

Status remains OPEN for the original causal attribution gap. The new lifetime-counter arithmetic correction is proven and applied at4c118e0d, but neither a fresh gate pass nor these controls invent the missing original baseline. Golden review: not applicable (no approval-gated hunk).


## 2026-11-04 owned-tick capture proves a distinct fixture assumption

The 4a2 controller failed the same live burner assertion. One authorized
unchanged owning-function invocation reproduced it in 2.047s and retained the
exact PID3557763/birth42455717 counters: ticks4->24 over0.524626s at100Hz
correctly yielded38.1%, rank6; ticks24->36 over0.556301s yielded21.6%, below
the global top8 cutoff28.8%, so omission was correct. Both samples showed100%
host CPU. The first-bad contract was the fixture's unconditional expectation
of at least50% CPU share, rather than a sampler arithmetic or identity defect.
This does not recover the missing identities of the older historical cases.

Reviewed fixture-only patch `ae90b65f3772d00bdaba476a00750f287fa120647ce03bb87a9a94561113d137`
checks actual same-birth delta/elapsed and correct globaltop8 rank. It still
requires positive live exercise, retains an independent controlled100%
(>=50%) arithmetic/ordering oracle, and refuses wrong delta, wrong birth and
omitted higher rank. Fixed-input replay of the same captured native data fails
the old assertion and passes the repaired oracle. A later native candidate
owning invocation passed1.900s; ambient shares differed, so that later pass is
not the fixed-input causal comparison. Production sampler bytes, original
single burner, 0.5s x2 samples, 30s subprocess budgets, redaction/inventory
checks and exact kill/wait are unchanged. No priority change, extra load,
weakened application assertion or global gate serialization was introduced.

Evidence: `/var/tmp/pr1662-4a2-cpu-sampler-rca/fixture-repair-report.json` and
`fixed-input-oracle-replay.json` (SHA256
`58113838d7841ba612aafaedcbed283f4bf19190f475b780287328c2e76b6b8d`).
This proves the new fixture boundary; it grants no full-controller or benchmark
PASS and leaves the original historical attribution gap open. This append
uses already saved proof and performs no new execution.
