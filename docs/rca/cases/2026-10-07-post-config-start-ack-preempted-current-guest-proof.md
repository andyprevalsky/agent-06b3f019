---
id: 2026-10-07-post-config-start-ack-preempted-current-guest-proof
date: 2026-10-07
title: Rejected post-config start ACK preempted the existing current-guest proof
surface: harness
component: cloudbench-boot-launch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-cloud exits after rejected start commands before its existing data-plane and current-RUNSTAMP proof can observe the configured guest
symptoms:
  - "provider did not accept the required post-config start"
  - "configured exact Machine reached started before the owning child exited"
tags:
  - cloudbench
  - startup
  - ownership
  - data-plane
sources:
  - commit 681481df0425caf0a8d2157b872027b11a8ef8f9
  - fleet run 20261007-020659-75781
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_post_config_start_rejected_ack_requires_current_guest_proof
status: open
---

## Problem

The original fifty-task LIVE control configured all fifty exact primary owners.
One child, `gate-source-connect-gmail`, terminated during post-config startup
and the ordinary tolerant barrier admitted the other forty-nine. The failed
child emitted no accepted-start marker or original current-guest log/health
proof. It cannot earn execution, evaluation, or full fifty-task outcome credit.

The owning original start log contains three MIGRATING diagnostics and a lease
diagnostic. It emits no per-attempt timestamps, so those clocks remain unknown.
The retained ordinary native inventory reports the exact configured Machine's
start event at epoch 1791364735.162; the original joined child completion marker
has local mtime 1791364736.018749 and exit 125. Native start preceded that marker
by 0.856749 seconds. Native source, run token, boot command, all three injected
helpers, and the exact compressed child payload match the original owner.
These facts prove configuration and native convergence, not guest readiness.
The provider's underlying migration or lease cause remains unproven.

## Diagnosis

The actual boot-update path always submits explicit bounded start mutations
after the shared config barrier. That requirement is necessary: a stale
inventory generation may still say started after a skip-start update stopped
the Machine. However, all nonzero command acknowledgments currently cause an
immediate exit before the already-owned exact-private-IP status proxy and
bounded current-RUNSTAMP log protocol can establish whether the configured
guest did boot. An intermediate acknowledgment became a terminal readiness
assertion despite the existing later section proof.

Archive searches were `unable to start machine current state migrating` and
`post-config start readiness lease migration`. The October 2 replacing-state
case and September 29 rejected-start recovery case were read, including their
solutions and human feedback. They establish related convergence and ownership
boundaries, but neither proves this platform event's cause.

The permanent owning control executes the actual post-config shell section,
the existing bounded log-reader functions, real loopback HTTP transfers, and
fixture native commands that reject all four explicit starts. Identical frozen
test bytes produce two failures and four passing inverses on the original
source: healthy current owners cannot reach their existing proof. The candidate
passes all six. Foreign RUNSTAMP, dead lifecycle 410, incomplete transfers, and
a proxy that dies after replying all refuse the atomic start marker.

The surrounding startup, data-plane proxy, log, and autoscaler family passes
thirteen controls. Shell syntax and diff checks pass. The fixture uses the
existing 600-second host supervision and 30-second cleanup allowances, without
sleep-based or microtiming assertions. Production retries and deadlines are
unchanged. The existing compact benchmark route selects all six new controls;
the full lifecycle suite already collects their owning module.

## Solution

Retain every explicit bounded start mutation. A rejected ACK remains in the
original diagnostic log while the child proceeds through its existing status
proxy and validated current-run log path. A previously unacknowledged start
gets the atomic exact-Machine marker only after that bounded current-RUNSTAMP
proof, a nonterminal 204 or 425 health response, and proxy survival before and
after the response. Dead or foreign guests never acknowledge this transition.

The existing proxy and log failure handling, synchronized readiness barrier,
task and evaluator behavior, autoscaler ownership, evidence collection, and
native retirement remain authoritative. No cached native started state can
suppress the required start calls or substitute for guest proof. No model,
task, provider workload, runtime cap, or additional gate is introduced.

The causal control proves the admission-ordering repair. It does not prove the
original Gmail guest became ready or that an actual task outcome is repaired.
The active source-frozen control remains unchanged. This case stays open until
independent review, normal source-bound deployment, and a fresh complete LIVE
control establish the actual startup and final ownership/resource boundaries.

## Human feedback

Use genuine section-end readiness with generous existing bounds, rather than
brittle intermediate ACK assertions. Preserve exact ownership and dead-guest
guards. Do not change an active control, infer missing clocks, impose new
assertions, or invent task credit. Keep isolated causal controls in the normal
owning family and use independent source review.

## Reusable lesson

Use the existing exact-owner readiness proof to establish convergence after a
required idempotent transition request, rather than treating a rejected command
acknowledgment alone as a terminal readiness failure.
