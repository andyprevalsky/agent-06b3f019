---
id: 2026-09-04-agentphone-timeout-collapsed-unknown-provider-state
date: 2026-09-04
title: AgentPhone timeout collapsed unknown provider state into email-only success
surface: back-end
component: agentphone-provisioning
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/agentPhone.ts:createAgentPhoneNumber
symptoms:
  - AgentPhone POST times out after the provider may have created an agent or number
  - auth options silently returns email-only identity after an ambiguous provider write
  - AgentPhone provider resource can exist without persisted provider IDs
  - live browser-provider parity fails after scanning 10,000 unrelated provider agents
tags:
  - agentphone
  - provisioning
  - timeout
  - reconciliation
  - orphan-resource
sources:
  - PR #1246
repro: back-end/src/tests/blackbox/auth-options.part2.blackbox.ts and back-end/src/tests/blackbox/agentphone-uncertain-provisioning.blackbox.ts
status: fixed
---

## Problem

AgentPhone agent and number creation are non-idempotent POST requests. Both
requests shared a ten-second abort signal. A timeout or network failure could
occur after the provider committed a resource but before Rose received the
response. `ensureMintedIdentity` caught every error and returned the already
created email identity, leaving no provider IDs with which to recover or clean
the possible AgentPhone resource.

The red blackboxes made both ambiguous boundaries deterministic. An aborted
agent POST was followed by a provider list containing the committed resource,
but the old code never issued the GET and returned email-only state. An aborted
number POST expected a GET of its known agent and a DELETE after the provider
confirmed no attached number, but neither occurred. A third case proved that a
failed reconciliation was swallowed instead of failing closed. The pre-fix
result was five passing and three failing cases in the affected auth-options
suite.

## Diagnosis

Archive searches for `AgentPhone timeout orphan reconcile`, `non-idempotent POST
ambiguous completion email fallback`, and `provider number provisioning cleanup`
found no exact prior case.

The first bad boundary was the client-side deadline around provider writes, but
the deeper defect was outcome erasure. A generic exception represented both a
confirmed 4xx rejection, where email fallback is safe, and an abort or 5xx,
where external state is unknown. The catch in auth options erased that
distinction. Sharing one signal also let a slow agent creation consume the
number creation's entire budget.

## Solution

Every provider request, including every reconciliation page, now has its own
bounded signal. Agent creation carries a deterministic SHA-256 provisioning
marker in its description. Rose acquires a database advisory lock keyed by user
only long enough to claim a committed provisioning lease. Provider HTTP then
runs outside the transaction, so a slow or timed-out request cannot consume a
database connection for its entire duration. Completion uses another short
locked transaction to exchange the exact lease marker for the provider
agent/number IDs. A waiting replica therefore reuses the persisted resource.

The first implementation scanned the entire provider account before every new
create. The live blackbox exposed that this is not a viable absence proof once
the account exceeds 10,000 agents. Ordinary first-time provisioning now creates
directly after the lease commits; paginated marker reconciliation is reserved
for an ambiguous create outcome. An uncertain failure writes a recovery marker,
and a crashed owner's lease expires into the same recovery-only path, so no
successor creates until a full marker scan proves absence. When `total` is
absent, full pages continue until an empty or short page. Agent-count and
elapsed-time bounds both fail closed instead of claiming a complete scan.

If number creation is ambiguous, Rose reads the known agent. It recovers an
attached active number, or deletes the newly created agent after the provider
confirms that no number is attached. Provisioning errors explicitly carry
whether email-only fallback is safe. Auth options falls back only after a
confirmed request rejection or successful cleanup; failed reconciliation is
surfaced so a later request can retry against the same marker instead of
creating untracked state.

The recovery, cleanup, and fail-closed blackboxes all pass through the standard
backend blackbox runner. The concurrency case pauses provider creation and
asserts that another database client can already observe the committed lease,
then proves two callers create only one provider agent and number. Synthetic
AgentPhone provisioning additionally requires an explicit isolated benchmark or
a non-production process, so a leaked flag cannot persist phantom provider
identities in production.

## Human feedback

The user insisted the isolation work be finished, cemented, and deployed after
the prior review cycle found this blocker.

## Reusable lesson

Never hold a database transaction across provider I/O; commit a recoverable lease first, and never turn an ambiguous non-idempotent write into fallback success until exact reconciliation or compensating cleanup proves the external outcome.
