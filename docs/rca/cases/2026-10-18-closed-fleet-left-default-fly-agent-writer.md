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

The first real retirement invocation then exposed a separate response-contract defect. Its guest plan completed with exit code zero, one target and no held targets, and returned a durable plan hash. Loading the canonical export checker also emitted exactly one `EXPORT_PHASE REMOTE_ENTERED` diagnostic on stderr. The host rejected all nonempty stderr, so it stopped after planning and before sending any signal. The recorded native responses and original plan remain the source of truth; rerunning the plan would not be an appropriate recovery.

The subsequent provider-free check exposed a reconstruction error: the durable intent saver sorts JSON object keys, while the original command encoded the payload's insertion order. Recompressing the reread intent therefore produced a different command string. Independent decoding of the retained request proved the same old guest source, payload, loader, timeout and Machine flag. The comparison must validate that exact command envelope and decoded source/payload rather than treating one compression serialization as the identity of the request. The original raw request remains unchanged.

## Prior archive search

The search `Fly agent controller export relay parent preflight` found related normal-export ownership and retained-retirement evidence cases. Existing relay retirement explicitly excludes its isolated Fly agent and cannot stand in for ownership of this default agent.

## Solution

Extend the existing orphan retirement command with a distinct normal-controller agent path. Reuse the original normal-owner proof and raw joined/canonical pending evidence. Require the exact process birth, UID, executable and binary hash, inherited source and fleet token, retained closed owner audit, and complete kernel listener/peer and process descriptor evidence. Recheck these facts before a single PID-bound TERM after publishing an exclusive intent. Unknown outcomes allow observation only; they do not authorize another signal.

Keep generic writer checks, archive verification and the original external caller's cleanup ownership. Preserve the actual retirement journal through the existing export evidence path. This mechanism must never signal PID1, a process group, an unregistered agent or an agent with active clients.

After the original experiment deadline expired, the user requested ten experiments and delegated the cutoff choice after the bounded alternatives were explained. Finishing the existing resource cleanup remains necessary before that batch. A separate, explicit cleanup hold ends at `2026-10-18T01:22:30.425Z`. The retirement and export commands accept that cleanup-only cutoff for this exact original epoch and hold. They keep the original task deadline, failed result, old plan identity and old operator unchanged. The new execution context records the cleanup authority separately and checks it again immediately before TERM. It grants no task, launch or retry authority.

## Verification and limits

Nine owning controls pass, including the normal command through recorded native request handling, one signal, duplicate-intent observation, existing export custody verification, real self-descriptor enumeration, and rejected incomplete captures, clients, queued connections and changed ownership. Actual retirement, export and resource release remain pending until their original receipts are obtained. Original77 remains a failed run with all attempts and clocks preserved.

The scoped continuation adds three controls, bringing the owning file to twelve passing tests. They cover the exact known diagnostic, a signal-only continuation preserving the original plan identity, and the saved raw plan parser with changed-source, raw-hash and foreign-file denials. A separate reproduction executes the actual export checker's module load: the old empty-stderr predicate rejects its phase line, while the new strict handler accepts the same successful plan response. The continuation keeps the original deadline; passing these controls does not authorize execution after it expires.

The separately authorized cleanup window adds one retirement and one export control: thirteen retirement and sixteen export controls pass. They cover an expired original task clock with the valid distinct cleanup window, unchanged original identity and deadline, and refusal of a foreign epoch, hold or cutoff. Root repeats the affected owning files successfully. Actual old-plan transport frames remain below the existing 16,384-byte limit, including the cleanup execution context. Actual retirement, export and release still require the executor's receipts.

The ordering repair brings the retirement file to fourteen passing controls. The new case reproduces a sorted intent roundtrip while retaining the original command order, then rejects a changed loader, guest source, payload or transport envelope. The exact retained production request also passes the frozen bounded decoder without any provider call or replay. The compressed command remains limited to the original transport size and one complete gzip member; only the representation's object-key order is disregarded.

## Human feedback

Continue the authorized deployment and benchmark task without bypassing writer checks or discarding evidence. Current-run cleanup and future source repairs remain separately attributable.

The user subsequently required discussion before starting each new fix. After the successful-plan refusal was explained, the user explicitly approved accepting the known diagnostic line and continuing from the saved retirement plan without replaying prior actions. This approval does not cover unrelated response errors, new cleanup authority, or changing the original run deadline.

After the command-ordering check failure was explained separately, the user explicitly instructed “fix it and do it.” That approval covers only the strict command-envelope comparison repair and continuation of the same saved plan. It does not authorize recreating the plan, replaying a signal, accepting a different guest program or payload, or extending the separately recorded cleanup cutoff.

## Reusable lesson

A daemon can outlive every task that started it. Resource closure needs a recorded daemon owner and an exact idle-state proof; a task's terminal result alone does not provide that proof.
