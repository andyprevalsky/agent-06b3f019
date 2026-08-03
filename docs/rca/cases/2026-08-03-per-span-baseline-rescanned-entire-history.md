---
id: 2026-08-03-per-span-baseline-rescanned-entire-history
date: 2026-08-03
title: Per-span baseline lookup rescanned the full history ledger until benchmark diagnostics timed out
surface: harness
component: benchmark-diagnostics
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/benchmarks/agent_latency.py::_span_baseline_map — each unique span key called span_history.summary, which decoded the entire JSONL history again
symptoms:
  - "[diagnostic timed out after 180 seconds]"
  - agent_latency.py remained CPU-bound in JSON decoding for more than 180 seconds
  - six failed ecommerce benchmark tasks produced no agent_latency report
tags:
  - agent-latency
  - span-history
  - diagnostics
  - performance
  - jsonl
sources:
  - agent 9c234058-7f6c-4274-b6d5-5110beaea31b
repro: agents/tests/blackbox/span_history.blackbox.py
status: fixed
---

## Problem

The Epoch 9 ecommerce benchmark diagnostics wrote the literal timeout marker
`[diagnostic timed out after 180 seconds]` for all six failed tasks instead of
producing latency reports. The isolated run contained 73 MB / 173,971 log
lines, and the historical span ledger contained 241,740 rows / 77 MB. An
identical local IMAX diagnostic stayed CPU-bound until it was interrupted at
189.51 seconds; a process sample placed execution in Python's JSON decoder.

This case is a relative of
`2026-07-11-agent-latency-crashes-on-no-span-retained-traces`: both disable the
primary benchmark diagnostic, but the earlier first-bad boundary was an
unhandled zero-span result while this incident was repeated full-ledger work.
Archive searches for `agent_latency diagnostic timed out after 180 seconds`,
`span history repeated scan performance timeout`, and `diagnostic CPU bound
JSON decode ledger per key` found no prior case with this cause.

## Diagnosis

`local.py::run_diagnostics` launched one `agent_latency.py` process per failed
task with a 180-second budget. The analyzer first admitted shared and neighboring
isolated contexts even when `BENCHMARK_CONTEXT_DIR` pinned one run, then decoded
worker events before filtering them by the requested agent. Those reader costs
were real but not sufficient to explain the full stall: after source filtering
was added, the unchanged diagnostic still remained CPU-bound for 99.95 seconds.

The deeper first-bad boundary was `_span_baseline_map`. It called
`span_history.summary()` once for every unique current span key, and every call
opened and JSON-decoded all 241,740 history rows. The owning blackbox counted 90
history-row decodes three times for three keys, proving `O(keys × history)`
work. This multiplicative ledger scan made the diagnostic exceed its collector
budget; the 180-second bound itself was not too aggressive.

## Solution

Made an explicit `BENCHMARK_CONTEXT_DIR` authoritative, resolved repo-relative
pins independently of the diagnostic process cwd, excluded shared and
neighboring run logs under that pin, and filtered raw log lines by the known
agent tree before JSON/backend parsing. Transitive child discovery builds its
spawn relationship index in one backend-log scan and reads relevant events in
one more, independent of tree depth. Added `span_history.summaries()` to group
every requested span key in one ledger pass; both the latency baseline renderer
and observation comparator now use that batch path.

The permanent benchmark and span-history blackboxes prove the pinned-context,
pre-decode filter, and one-ledger-scan contracts. The identical IMAX diagnostic
went from more than 180 seconds to 1.62 seconds, and the no-network form finished
in 0.81 seconds. At 10k agents this remains an offline diagnostic with one
sequential history pass, two backend-log scans independent of tree depth, and
set-based UUID membership independent of known-tree width, rather than a
runtime fan-in or a per-key full-corpus scan; it adds no shared state, polling,
locks, or hot-path work.

## Human feedback

None recorded.

## Reusable lesson

Batch diagnostic baseline lookups into one ledger scan, and filter pinned run logs before decoding them.
