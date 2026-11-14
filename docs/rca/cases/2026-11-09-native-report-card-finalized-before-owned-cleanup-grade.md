---
id: 2026-11-09-native-report-card-finalized-before-owned-cleanup-grade
date: 2026-11-09
title: Terminal report projected PASS before owned cleanup finalized the canonical grade
surface: harness
component: agents/benchmarks/run_benchmark.py terminal report emission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: main_async emitted its last report before the owning batch finalizer could persist an ERROR grade
symptoms:
  - report-card.json passed1 while canonical benchmark_status ERROR
  - terminal report retained pre-cleanup PASS
  - closed report sink could replace the cleanup exception
tags:
  - benchmark
  - report-card
  - cleanup
  - exception-preservation
sources:
  - commit f61b9e9394b0e6cf0bd51f929d682c2ee57a5497
  - agent 7b09d979-4bb6-4b0e-a3d0-fd9595e7d1d8
  - plan:.context/agentcard-stability/terminal-report-rca/red-green-sealed.json
repro: agents/benchmarks/cloud_batch_cleanup_test.py terminal_report_refreshes and terminal_report_closed_sink regressions, auto-registered by benchmark.blackbox.py
status: open
---

## Problem

Native partial11 round01 setup-resume persisted canonical ERROR/passed=false
when ownership cleanup failed, but report-card.json still showed passed1/failed0.
The resulting false PASS visual was explicitly invalidated. Original canonical,
report and visual evidence remain preserved in the round01 packet; the terminal
benchmark ERROR and ten queued cancellations were never converted into passes.

## Diagnosis

Evaluation PASS -> last report emission -> owned batch finalization -> cleanup
changes canonical grade to ERROR and saves -> exception exits before another
report. The final projection preceded the last authoritative grade mutation.
A second owning-boundary case showed that publishing to a closed diagnostic
sink from finalization could replace the original cleanup exception/cancellation.

Searches used report-card PASS stale cleanup final error and scorecard precleanup
grade terminal finalization. Related cases
2026-10-18-benchmark-finalizer-discarded-published-error and
2026-09-09-cloud-fleet-terminal-artifacts-split-sources-of-truth concern different
publication boundaries; no duplicate of this producer ordering was found.

## Solution

The applied fix emits the existing native report after the existing owning
finalizer, including its exceptional path. Diagnostic closed-sink failures do
not replace the original cleanup RuntimeError or cancellation. No alternate
report, historical artifact rewrite, evaluator, timeout or prompt was introduced.

Same-command causal red/green receipt:

```bash
agents/venv/bin/python -m pytest .context/agentcard-stability/terminal-report-rca/candidate/agents/benchmarks/cloud_batch_cleanup_test.py -k terminal_report_refreshes_after_owned_cleanup_final_grade -q
```

red-green-sealed.json records exit1 ->0 with identical test hash. The real main
report producer, finalizer AST, card emitter and canonical save are exercised;
network, Hub, collector and history boundaries are isolated. Permanent tests
also cover PASS/FAILED/CANCELLED, closed sinks preserving cleanup RuntimeError,
and genuine cleanup cancellation. They are automatically registered by
agents/tests/blackbox/benchmark.blackbox.py for deploy's agent blackbox gate.
Parent public checks report130 cleanup/report tests PASS after the reviewed fix.

Earlier diagnostic isolation accidentally appended synthetic history rows.
The original rows and restoration hashes remain in terminal-report-rca/history-quarantine;
parent removed only those synthetic additions. The sealed reproduction records
unchanged real history and trapped outbound boundaries. No historical packet
capture is inferred from later guarded replay.

**Native limit:** the original cleanup-ERROR/false-PASS pair is actual runtime
evidence. Later native rounds02..04 agree on PASS, and round05's actual signup
FAILED grade agrees with its report. A post-fix native replay of the specific
cleanup-error and closed-sink branches was not performed; those branches have
registered owning-test proof only. This case remains open for that exact native
outcome-verification gap, rather than claiming the branch was replayed or the
full browser stability goal completed.

The registered full-domain command is `cd agents && venv/bin/python scripts/run_blackbox_tests.py benchmark`. It was not rerun for this documentation-only task; recorded historical checks and their limits are stated above.

## Human feedback

Repair the owning grade-to-report publication order, preserve the original
ERROR/false-card artifacts, and preserve cleanup exceptions. Unit/AST controls
must not be relabelled as native E2E outcomes or account for real history writes.

## Reusable lesson

Project terminal state after its last owning mutation, and never let diagnostic publication replace the primary failure.
