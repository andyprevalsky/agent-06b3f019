---
id: 2026-07-11-agent-latency-crashes-on-no-span-retained-traces
date: 2026-07-11
title: agent_latency.py crashed on retained traces from deleted agents instead of reporting that no spans could be reconstructed
surface: harness
component: benchmark-diagnostics
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/benchmarks/agent_latency.py — retained log events that reconstruct zero spans were not a handled case
symptoms:
  - agent_latency.py crashes when run against a deleted agent's trace
  - retained log events present but no reconstructed spans
tags:
  - agent-latency
  - span-history
  - diagnostics
  - deleted-agent
  - retained-logs
sources:
  - PR #739
repro: agents/tests/blackbox/span_history.blackbox.py
status: fixed
---

## Problem

Running `python benchmarks/agent_latency.py <agent_id>` against an agent whose
record had been deleted crashed instead of producing a report. The retained logs
still existed, but they reconstructed zero spans — precisely the situation in
which an engineer most needs the tool to say something useful.

## Diagnosis

The latency reconstructor assumed at least one span would come out of the
correlated log sources. A deleted agent leaves retained log events with no
span-bearing rows to correlate, so the zero-span path fell through into a crash.
The failure mode is self-defeating: the diagnostic that exists to explain a
missing/odd run was the one thing that broke when the run was missing, so the
operator got a traceback rather than the fact that no spans were recoverable.

## Solution

Hardened retained-trace diagnostics so `agent_latency.py` reports "retained log
events with no reconstructed spans" instead of crashing. Verified live against
agent `f6c10bff-b75b-4bb6-ab46-948ecec3920f` with
`--no-wall-clock --no-fe-cadence --no-record-span-history`, and cemented by the
span-history no-span regression in `agents/tests/blackbox/span_history.blackbox.py`.

## Human feedback

None recorded.

## Reusable lesson

A diagnostic tool must degrade to an explicit empty-result report on missing or
partial trace data — a crashing diagnostic converts an observability gap into a
dead end.
