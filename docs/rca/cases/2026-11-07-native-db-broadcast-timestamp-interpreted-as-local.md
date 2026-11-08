---
id: 2026-11-07-native-db-broadcast-timestamp-interpreted-as-local
date: 2026-11-07
title: Native database broadcasts added eight hours to a paused work batch
surface: front-end
component: realtime-payload-extractors
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/lib/realtime-types/extractors.ts accepted native Postgres timestamps as API timestamps without normalizing the database wire contract
symptoms:
  - Interrupted after 9h 21m
  - paused agent duration inflated by eight hours
  - canonical REST refresh rejected as stale after a database UPDATE
  - native Agent UPDATE updatedAt has no timezone
tags:
  - realtime
  - timezone
  - trajectory-work-group
sources:
  - agent 77783ad2-f547-473d-8191-a98c173edc97
  - commit 87b887bd39f8d762976fb33511aaafcb8e023512
repro: front-end/src/tests/blackbox/trajectory-work-batch.blackbox.tsx
status: fixed
---

## Problem

The user reported “Interrupted after 9h 21m” for an agent created at
2026-11-07T18:57:07.303Z and paused at 20:20:51Z. Its trailing work batch starts
at 18:58:57.979Z, making the correct label “Interrupted after 1h 21m”.
Read-only production queries captured both retained native UPDATE frames in
realtime.messages: at 20:20:51.003033 the row has updatedAt
2026-11-07T20:20:51.002, and at 20:20:51.227685 it has
2026-11-07T20:20:51.226. Both omit the timezone. The enabled live
agent_broadcast_trg invokes realtime.broadcast_changes with NEW; its live
function builds record=NEW directly. This is production evidence, not a
synthetic missing-Z hypothesis. The API emitter separately logged a qualified
20:20:51.002Z update, and the REST response has 20:20:51.226Z.

The agent's own report-bug endpoint returned a launched report about browser
timeouts and cleanup; it does not report or explain this duration bug. That
separate browser failure is outside this duration repair.

## Diagnosis

Critical path: naive UTC database column → native database broadcast → shared
realtime extractor → handleUpdateAgent → freshness reconciliation → work group
→ workLabel. Database and API broadcasts share the agent topic but carry two
contracts. The extractor validated partial UPDATE fields without adapting the
native database row. In America/Los_Angeles, Date.parse interprets the native
20:20 timestamp as local PST, adding 28,800,000 ms. The inflated timestamp then
wins the freshness check, so subsequent qualified API and REST updates are
rejected as older. The duration renderer correctly subtracts the wrong epoch.
Native rows also lacked agentId, bypassing the handler's conditional identity
check. The native Message trigger has the same timestamp contract, so mixing
raw INSERTs with API updates can corrupt the batch's start as well.

The permanent owning-boundary blackbox was executed before the fix:
`cd front-end && TZ=America/Los_Angeles npx vitest run src/tests/blackbox/trajectory-work-batch.blackbox.tsx`.
It failed with expected “Interrupted after 1h 21m”, received “Interrupted after
9h 21m” (1 failed, 12 passed). The added raw-ingress tests also failed 4/66
before the fix. The unchanged command passes afterward, as do the same
extractor assertions. An independent managed investigator replayed the actual
retained frames through extraction, state application and REST reconciliation:
before the fix parsed epoch 1794111651226 instead of 1794082851226; after the
fix the identical test passes, recovering epoch 1794082851226. The real UI
and extractor suites pass 79/79 after the fix. Independent adversarial review
found no blocking correctness objection.

Archive searches: “Interrupted after duration”, “elapsed timezone timestamp
paused”, and “naive timestamps broadcast updatedAt”. The naive-trigger cleanup
case from 2026-07-24 and unreproduced client-clock case from 2026-10-26 are
relatives, not recurrences: their first-bad boundaries differ. Early replay of
only REST correctly rendered 1h 21m; the decisive evidence was the second,
native database emitter, omitted by the initial JavaScript-only producer audit.

## Solution

Normalize native public.Agent and public.Message envelopes once in the shared
realtime adapter, using the existing UTC date parser. Native Agent.id becomes
agentId; updatedAt and Message.timestamp become qualified ISO instants before
validation and state/freshness logic. Qualified offsets are respected; API
frames stay unchanged. Invalid native dates use the existing extraction error
path. Input records are not mutated.

This unifies contracts instead of capping durations, changing clocks, or adding
recovery state. Removing the database emitter would require proving every
DB-only update has another publisher; adapting its legitimate native contract
preserves delivery. Cost is constant per incoming frame, with no new channels,
polling, API requests, or per-agent state at 10,000 agents.

The permanent MessageList regression covers the exact pause frames, displayed
label and acceptance of canonical REST refresh. The existing realtime extractor
blackbox covers native Agent identity, UTC/no-zone/explicit-offset timestamps,
raw Message INSERT normalization and immutability. The standard Vitest include
pattern discovers both; the frontend coverage-blackbox deploy gate runs them
for this front-end change. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user required completing RCA followed by deployment and being relentlessly
resourceful. No additional correction or rejected fix was recorded.

## Reusable lesson

Normalize native database broadcast identities and UTC timestamps at the realtime adapter before comparing them with API snapshots.
