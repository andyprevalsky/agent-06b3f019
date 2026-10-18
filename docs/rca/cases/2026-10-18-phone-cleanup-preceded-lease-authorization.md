---
id: 2026-10-18-phone-cleanup-preceded-lease-authorization
date: 2026-10-18
title: Phone request cleanup ran before lease ownership and admission checks
surface: back-end
component: iphone-operations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/service.operations.ts performPhoneCommand pre-claim cleanup
symptoms:
  - Denied request initiated provider cleanup
  - Lease not found
tags:
  - phone-harness
  - ownership
  - authorization
  - cleanup
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/iphone-control.blackbox.ts
status: fixed
---

## Problem

Review found cleanup could precede a lease request's denial. The real API/DB
blackbox created an uncertain physical input, expired its fixture deadline, and
sent requests for nonexistent leases plus queued input. They returned 404/409
but made provider cleanup calls for the authenticated caller's own pending
phone. No foreign account's phone was selected.

Command from back-end: `bash scripts/run-blackbox-tests.sh iphone-control`.
Pre-fix run `1792350914-2324524-30658` failed with `Denied request initiated provider
cleanup`, with 16/17 cases passing. The unchanged regression passed in the
8-domain run `1792350948-2330467-32066` after the fix.

## Diagnosis

Critical path: authenticated request -> eager device reconciliation/cleanup ->
provider stop/receipt -> requested lease ownership/admission -> denial. Cleanup
was legitimate for a current owned interaction, but it ran before establishing
that the supplied lease represented one. The generic eager-maintenance ordering
violated the no-provider-access contract for denied phone actions.

The first bad boundary was the service entrypoint, before command claim or
owned-lease validation. The general fix is to establish request ownership and
admission before external effects. Provider behavior and the queue were correct;
the new pending-session fixture exposed ordering the fresh-device denial cases
could not.

## Solution

Remove eager cleanup before command claim. Commands must own an active lease and
the correct control actor before constructing a provider client. Lease actions
validate ownership before cleanup; valid owned lease reads still drive cleanup
and FIFO recovery. Post-command cleanup remains tied to the accepted operation.

Keep the pending-device regression in the normal backend blackbox suite. The
combined run passed iPhone queue, iPhone control, capture privacy, browser auth,
attention, auth options and messaging domains. The added ownership read is
indexed by lease ID, with constant work per request and no new lock, channel or
cross-agent fan-in at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Authenticate and bind the requested interaction before performing external cleanup on its behalf.
