---
id: 2026-10-18-closed-fleet-left-default-fly-agent-writer
date: 2026-10-18
title: A default Fly agent outlived a closed controller workload
surface: infra
component: cloudbench-controller-orphan-drain
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: controller export detected a surviving default Fly agent but the existing orphan retirement command supported only expired borrowed controllers and registered fleet or relay owners
symptoms:
  - canonical controller export returned pending with one remaining writer
  - the writer was an orphaned default Fly agent with a closed fleet owner
tags:
  - cloudbench
  - export
  - process-ownership
sources:
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - commit ffe622243b8d704692fd3b69ab1d08eb1bb54040
  - fleet run original600-1792279176545861179
repro: python3 scripts/tests/cloudbench-controller-orphan-drain.test.py
status: open
---

## Problem

After Original77's supervisor and campaign stopped, the canonical collector retained the controller because one process still referenced its repository. A read-only export readiness check identified that exact PID and birth. A separate bounded identity capture showed `flyctl agent run`, not the registered relay bootstrap or a surviving task controller. The existing retirement paths could not represent this resource under a normal controller owner.

## Diagnosis

The recorded agent inherited the original workload source and fleet token. Its retained audit identifies run `20261017-234329-1700`, reports provider teardown verified, and remains available after the live registration was removed. The original owner PID is absent. The agent is parented by PID1, has no child processes, and uses the default home Fly socket and lock.

The first supplementary capture failed after assuming a live registration record still existed. The next complete kernel socket dumps showed the agent's listener, no pending accepts or peer connections, and an identical relevant graph before and after the observation. That capture still reported a process-descriptor race and was retained as incomplete. A local reproduction identified the cause: collecting all entries of `/proc/self/fd` closes its own directory descriptor before a later `readlink`. Keeping the directory iterator open during inspection fixes the census without ignoring descriptor errors. The corrected capture completed and its saved ownership facts passed offline validation; no earlier incomplete capture authorized a signal.

The exact originating Fly invocation is not proven. A missing parent canary relay environment is a separate established routing defect, but other direct SSH and SFTP commands can also start a default agent.

## Prior archive search

The search `Fly agent controller export relay parent preflight` found related normal-export ownership and retained-retirement evidence cases. Existing relay retirement explicitly excludes its isolated Fly agent and cannot stand in for ownership of this default agent.

## Solution

Extend the existing orphan retirement command with a distinct normal-controller agent path. Reuse the original normal-owner proof and raw joined/canonical pending evidence. Require the exact process birth, UID, executable and binary hash, inherited source and fleet token, retained closed owner audit, and complete kernel listener/peer and process descriptor evidence. Recheck these facts before a single PID-bound TERM after publishing an exclusive intent. Unknown outcomes allow observation only; they do not authorize another signal.

Keep generic writer checks, archive verification and the original external caller's cleanup ownership. Preserve the actual retirement journal through the existing export evidence path. This mechanism must never signal PID1, a process group, an unregistered agent or an agent with active clients.

## Verification and limits

Nine owning controls pass, including the normal command through recorded native request handling, one signal, duplicate-intent observation, existing export custody verification, real self-descriptor enumeration, and rejected incomplete captures, clients, queued connections and changed ownership. Actual retirement, export and resource release remain pending until their original receipts are obtained. Original77 remains a failed run with all attempts and clocks preserved.

## Human feedback

Continue the authorized deployment and benchmark task without bypassing writer checks or discarding evidence. Current-run cleanup and future source repairs remain separately attributable.

## Reusable lesson

A daemon can outlive every task that started it. Resource closure needs a recorded daemon owner and an exact idle-state proof; a task's terminal result alone does not provide that proof.
