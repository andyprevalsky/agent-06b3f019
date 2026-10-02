---
id: 2026-10-01-explore-timeout-dropped-heartbeat-evidence-list-vs-tuple
date: 2026-10-01
title: Explore timeouts lost their heartbeat evidence because Temporal decodes last_heartbeat_details as a list, not a tuple
surface: agents
component: spawn-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/handler.py wrap_up_payload_from_failure, which unpacked heartbeat details only when they were a tuple
symptoms:
  - explore agent timed out and returned no findings
  - last_heartbeat_details
  - explore timeout during an LLM call drops the tool evidence
tags:
  - explore-agent
  - temporal
  - heartbeat-details
  - evidence-recovery
sources:
  - PR #1354
repro: agents/tests/blackbox/spawn_agent.blackbox.py
status: fixed
---

## Problem

The explore wrap-up path is meant to recover a timed-out explore's compiled
findings from its last heartbeat. Every real timeout returned nothing. The
existing tests passed because they built the heartbeat details as a tuple.
A second gap was that a timeout landing during an LLM call (when no tool loop
heartbeat had fired recently) carried no evidence at all.

## Diagnosis

Temporal's `TimeoutError.last_heartbeat_details` is decoded as a list.
`wrap_up_payload_from_failure` handled only tuples, so for real failures it
treated the list as a single opaque value and found no payload. The tests
fabricated tuples, which masked it. Separately, explore heartbeats carried the
compiled result only from the tool loop, so a heartbeat from inside an LLM call
replaced it with nothing. The deepest owned cause is test fixtures that encoded
an assumption about the SDK instead of the SDK's real decoded type.

## Solution

- `wrap_up_payload_from_failure` accepts a list or tuple and returns the first
  dict payload (or a non-empty string as `{"result": ...}`).
- The explore activity runs inside `heartbeat_resume_details`, so every heartbeat
  carries the latest compiled result and recent tool results.
- The tests now build a real `TemporalTimeoutError` with list details.

10k agents: no new I/O. The heartbeat payload is bounded to the last eight tool
results.

## Human feedback

None recorded.

## Reusable lesson

Build failure fixtures from the SDK's real exception types, so decoded shapes
(list versus tuple) match production.
