---
id: 2026-10-07-retained-recovery-stack-held-latency-ratchet
date: 2026-10-07
title: A stack retained for payment recovery held the semantic latency ratchet after its benchmark had exited
surface: harness
component: isolated-benchmarks
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/isolated-benchmarks.sh live_isolated_benchmark_runs treated any running manifest with a live run.sh as an active benchmark, including a stack retained only as recovery authority
symptoms:
  - "Waiting for isolated benchmark runs to finish before measuring latency:"
  - "1791396285-2126832-43519 (run.sh PID 2127016)"
  - "Owned cleanup is unverified; retaining services and database"
tags:
  - semantic-latency
  - deploy-step-6b
  - agentcard
  - retained-stack
sources:
  - PR #1417
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

In `/deploy` for PR #1417 (HEAD `e2b20fa1a`), the Step 6b latency ratchet was
waiting for isolated benchmark runs in the worktree. After the AgentCard
lifecycle lane failed `agent-payment-abandonment`, it kept waiting on that
lane's stack `1791396285-2126832-43519`. The lane's controller and its
`run_benchmark.py` child had both exited. The ratchet would have failed at its
3600-second budget, and any later deploy on this checkout would have blocked
the same way.

## Diagnosis

`agent-payment-abandonment` hit the open AgentCard release stall
(`2026-10-02-agentcard-abandonment-closed-card-transfer-never-released`). The
owned payment drain timed out, so `benchmarks/local.py` recorded
`local-benchmark-owner.json` as `failed_retained` and left `run.sh` running.
The backend reconciler keeps the purchase's recovery authority. All four roots
had already been deleted with verified provider cleanup.

`live_isolated_benchmark_runs` lists a custom-id or controller-less run as live
whenever its `services.json` says `starting`/`running` and its `run.sh` PID is
alive. A retained stack meets both conditions for as long as AgentCard holds the
release; AgentCard withheld one such release for 12.5 hours on 2026-10-03. The guard
exists because benchmark agents drain the shared Cerebras/OpenRouter quota
(`2026-10-01`). A retained stack whose benchmark child is gone runs no agents.

Reproduction: on the retained stack, the helper printed
`1791396285-2126832-43519 (run.sh PID 2127016)` while PIDs 2126832 and 2130463
no longer existed.

## Solution

A run whose owner record is `failed_retained` no longer counts as live once that
record's benchmark child PID has exited. A live benchmark child still holds the
ratchet, which covers a cleanup deadline that expired while the child was
running. Any other owner state, and a missing or non-integer PID, still hold the
ratchet. The ratchet's threshold is fixed at 5 seconds, so a missed contaminating
run can only cause a visible latency failure, never a false pass. The retained
stack, its database and its recovery authority are unchanged.

`semantic-deploy-gate.test.sh`, in the deploy structural registry, covers four
cases: a retained stack with a live child, a non-retained owner with an exited
child, a retained stack with an exited child, and a malformed PID. It failed the
exited-child case before the fix and passes after it. The real helper now
returns no live runs for `1791396285-2126832-43519`.

## Human feedback

None recorded.

## Reusable lesson

A process kept alive as recovery authority is not active work; liveness guards
must read the owner's recorded state, not just whether the process exists.
