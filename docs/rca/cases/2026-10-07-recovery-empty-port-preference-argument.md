---
id: 2026-10-07-recovery-empty-port-preference-argument
date: 2026-10-07
title: Exact recovery sent an empty optional preference to an integer port allocator
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet claim_recovery_status_proxy_ports serialized absent preference as --start empty instead of numeric zero
symptoms:
  - "argument --start: invalid int value: ''"
  - "could not claim exact stale-owner recovery proxy ports"
  - "exact stale fleet ownership recovery failed"
tags:
  - cloudbench
  - recovery
  - port-lease
  - optional-argument
sources:
  - commit 6d9df062b6bccc1bdbc1888c251eb95c1e475986
  - fleet run 20261007-020659-75781
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The original fifty-task LIVE control ended with code 1 and zero acceptance
credit. Forty-nine completed task resources had retired; one configured guest
had actually started despite rejected native start requests and never published
its local status-proxy port. The reviewed current CLI correctly mapped that
remaining original allocation to preferred port zero, but its exact-owner
recovery failed before reconnecting the status proxy. Its original private log
contains the integer-parser error above followed by the proxy-port claim error.
The exact registry and both cleanup/evidence latches remained intact. No native
absence or never-started claim followed from this local error.

## Diagnosis

The path is exact owner planner -> remaining guest preferred port zero ->
preferred_start stays empty -> shell lease adapter emits an empty --start value
-> the actual allocator's integer parser rejects it -> recovery retains ownership.
The planner and allocator agree that numeric zero means no preference. The first
bad boundary is their shell adapter, which passed an empty string instead. The
allocator already defaults --start to zero and claim_batch uses its existing
10240 scan start for that value; there is no evidence of port exhaustion or a
provider/volume failure.

Archive searches were `could not claim exact stale-owner recovery proxy ports`
and `rejected start recovery no preferred status proxy port`. The September 29
capacity-rejected mapping case is a relative: it introduced valid port-zero
mappings, but its mixed cohort supplied other positive preferences. This is a
separate adapter-consumer gap, not a recurrence of its planner rejection.

The permanent test uses the real extracted claim/release shell adapters and
actual cloudbench-port-lease.py, with private fixture lease roots. Run:

```bash
agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k exact_recovery_consumes_runtime_receipt_proxy_ports -rA
```

Against the immutable pre-fix script, the unchanged five controls produced one
failure and four passes in 0.85 seconds: only absent preference failed with the
same argparse error as the original CLI. After the one-line adapter correction,
the identical test bytes and command produced five passes in 0.88 seconds.
They cover absent preference, explicit zero, retained positive preference,
malformed nonempty preference, and out-of-range preference. Successful cases
validate exact PID, birth and token, retain the lease for a wrong token, then
release the correct lease; every fixture is joined with its process group absent
and no private numeric lease records remaining. No provider call is involved.

The normal scripts/tests/benchmark-live-results.test.py compact selector already
includes the existing exact_recovery_consumes_runtime_receipt family, so these
controls run without changing its command or phase. scripts/test.sh also
discovers this file in Cloud Benchmark Lifecycle. Earlier broad recovery
fixtures stubbed the claim adapter, while planner-only tests stopped before it;
that is why a valid no-preference mapping had no downstream regression coverage.

## Solution

Represent a missing or empty preferred port as numeric zero at the shell adapter.
An explicit nonempty value still reaches the same allocator and keeps its integer
and port-range validation. The allocator, preference selection, ownership rules,
cleanup contracts, benchmark definitions and timing budgets are unchanged.

The general class is an optional shell value crossing a typed CLI boundary with
an invalid absence representation. Normalize that representation at the owning
adapter; do not relax the integer parser or override the original guest's port.
The golden-reference analog is
claude-code-src/src/services/oauth/auth-code-listener.ts:45, which passes an
absent optional port as integer zero to listen. The correction converges on that
representation. openclaw, hermes-agent and codex reference clones were not present
in this isolated checkout; no behavior is attributed to them.

This record remains open for the actual supported recovery and native closure.
The mechanism has unchanged owning RED/GREEN proof; the original failed control
and recovery attempts remain zero credit. No benchmark rerun or fixture result
substitutes for the original outcome or proves native release.

## Human feedback

None recorded for this adapter RCA. The requested control preserves the original
source, outcomes, model/task/evaluator/timeout inputs and exact ownership. Recovery
uses the documented CLI, with no manual provider-ID or forensic workaround and
no acceptance credit.

## Reusable lesson

Represent absent optional shell arguments in the typed consumer's documented form while preserving explicit-value validation and exact ownership.
