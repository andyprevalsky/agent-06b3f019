---
id: 2026-10-07-shared-callee-number-mapping-accepted
date: 2026-10-07
title: Configured callee mapping let two phone tasks attach personas to one Vapi number
surface: agents
component: phone-callee
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/phone_callee.py:_configured_number_id_for_task accepted a BENCHMARK_CALLEE_PHONE_NUMBER_IDS number assigned to two tasks
symptoms:
  - "inboundPhoneCall answered by another task's benchmark-callee assistant during a parked hold"
  - "BENCHMARK_CALLEE_PHONE_NUMBER_IDS assigns callee number"
  - "phone-call-client-intake and phone-call-hold-queue share one callee number"
tags:
  - phone-callee
  - vapi
  - cross-run-isolation
  - capability-proof
sources:
  - PR #1417
  - agent 8731c9b2-a8f2-4b2b-863f-1187bd9d45ea
repro: agents/benchmarks/phone_callee_test.py
status: mitigated
---

## Problem

The passing 2.5-hour `phone-call-hold-queue` run (agent `8731c9b2`) attached its
representative persona (assistant `9bd53dae`) to configured Vapi number `3cb0b76d`
at 22:42 UTC and parked its outbound call on the hold line until the 01:12:47
transfer. Vapi's call log for that number shows a different inbound call at
00:31:49, answered by assistant `08cf14f7`. Another runner's
`phone-call-client-intake` session had attached its own persona to the same
number mid-hold, then restored ours. The hold-queue transfer happened to land
after that restore. A transfer inside the 00:31–00:33 window would have reached
the intake persona and failed the run for reasons unrelated to the agent. The
injected `BENCHMARK_CALLEE_PHONE_NUMBER_IDS` (same in `agents/.env` and
`back-end/.env`) assigns `phone-call-client-intake` and `phone-call-hold-queue`
the same number ID. Values were inspected by 8-character prefix only.

## Diagnosis

`PhoneCalleeSession.setup` attaches the task's persona assistant to the resolved
number and restores the previously attached assistant at cleanup. That
attachment is one mutable field per number, so a number is exclusive to one live
session. `_configured_number_id_for_task` documents that requirement ("distributed
phone tasks also cannot share one mutable number-to-assistant attachment") but
only rejected malformed entries and duplicate task names. It returned the shared
number to both tasks. `scripts/fleet_infra_sample.py:configured_callee_names`
mirrors that parse and admitted both tasks to capability sampling. Neither
boundary checked number exclusivity. The archive search for the mapping variable
found only the 2026-09-30 case about a missing assignment. That case has the same
mapping but a different first-bad decision.

## Solution

`_configured_number_id_for_task` now raises when the requested task's number is
also assigned to another task, naming every task that shares it. Tasks with their
own numbers still resolve, so one misassignment blocks only the tasks involved.
`configured_callee_names` treats tasks that share a number as unassigned, so
capability sampling excludes them and an explicit pool containing one fails
before provisioning. This does not change any prompt, evaluator, timeout or score.

Repro before the fix:
- `pytest benchmarks/phone_callee_test.py -k shared` failed with
  `AssertionError: phone-call-client-intake resolved a callee number another task also attaches to`.
- The sampler check under the shared mapping returned both tasks as eligible.

Both pass after the fix, and `scripts/tests/fleet-infra-stability-proof.test.sh`
passes. The phone-callee cases run in the agents benchmark blackbox domain.

At 10,000 agents this adds one in-memory scan of a small mapping per phone
session, with no provider requests.

Status remains mitigated. The injected mapping still shares the number, so both
affected tasks now fail closed until the Cursor secret assigns
`phone-call-hold-queue` its own number. A dedicated free number
(`rose-benchmark-callee-hold`) was provisioned for that purpose. Concurrent copies
of one task on its configured number are still unguarded.

## Human feedback

The user asked for the hold-queue bench to be as realistic as possible and to pass
with zero overfitting. They did not comment on number assignment.

## Reusable lesson

Validate a configured exclusive-resource mapping for exclusivity of the resource,
not only uniqueness of its keys, at every boundary that consumes it.
