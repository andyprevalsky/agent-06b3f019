---
id: 2026-11-08-phone-admission-followed-refreshed-workflow-run
date: 2026-11-08
title: A pending phone command followed its borrower into a replacement workflow run
surface: back-end
component: iphone-execution-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.commandJournal.ts createCommandJournal
symptoms:
  - An old context-free CONNECTING command was admitted after the borrower first run changed
  - Normal interaction polling refreshed current custody and concealed the old admission identity
tags:
  - phone-harness
  - generation-fence
  - asynchronous-admission
  - workflow-replacement
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/iphone-control.continuity.cases.ts
status: fixed
---

## Problem

An admitted command captured its actor's workflow ID, but not that workflow's
true first execution run. Completed device facts legitimately survive a normal
agent's retirement. After a current borrower restarted under the same workflow
ID, ordinary interaction polling could establish the new run's current attempt
while an old context-free command was still CONNECTING. Comparing only the
workflow ID then let that old command become RUNNING under the new admission.

## Diagnosis

A registered local HTTP/repository reproduction established configured reuse,
created a real context-free command journal, changed the current borrower's first
run, and polled the ordinary interaction endpoint. It confirmed that the new
attempt matched the new first run and current availability was legitimate. The
original beginExecution(claim) then returned true instead of false. This is an
admission-boundary failure, not a claim that the fixture sent a physical action.

The owning failure used real local PostgreSQL and normal phone route fixtures;
only the external phone service was synthetic. Its native case failed in 3.658s.
The same failing assertion passed after the repair in 3.629s, with an added
positive control proving a fresh command from the new run can be admitted. Both
owned databases were dropped after zero connections and free ports. Original
failure evidence remains in round43-producer-owning/current-claim-red.

## Solution

Capture the actor's real first execution run beside its workflow in the
server-only command claim, under the existing transaction locks. After any
asynchronous preparation, execution custody compares that immutable claim with
the current actor before admitting execution. An absent or changed first run
rejects the old claim and retires its active slot. No caller can supply or
reconstruct the admission snapshot for replay.

Keep committed setup provenance independent of the setup actor's lifetime. A
permanent dependency on the original producer would recreate the normal-retirement
bug rather than fence this current-actor race. Device/account/profile, privacy,
current task/lease and fresh runtime checks remain separate. No database schema,
public tool schema, timeout, phone reset or production environment changes.

The earlier v6 scoped review and 149-case pass preceded this newly demonstrated
interleaving and remain historical, not clearance for this repair. Fresh exact
review, full normal gate validation and real production acceptance are required.

## Human feedback

The user requires normal completed phone setup to be reusable, exclusive current
control, and reliable cleanup on completion, cancellation or failure. Preserve
Freedom, do not reset the phone, and do not resend the original failed message.

## Reusable lesson

A refreshed current-state view must not rewrite an asynchronous operation's
original authority: capture and compare the complete execution chain at admission.
