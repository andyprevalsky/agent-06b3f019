---
id: 2026-10-13-committed-broadcast-discarded-after-timeout
date: 2026-10-13
title: Committed message broadcasts were discarded after an uncertain send
surface: back-end
component: realtime-broadcast
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: supabaseBroadcast removes committed INSERT notifications before sending and permanently discards a failed batch
symptoms:
  - accepted browser lifecycle messages were absent from the selected conversation
  - a timed out broadcast removed its messages from the publisher queue
tags:
  - realtime
  - supabase
  - delivery
  - browser-chip
sources:
  - agent 9a268261-9e28-4ca5-8141-b233db14f8ce
  - PR #1490
repro: back-end/src/tests/blackbox/committed-message-broadcast.blackbox.ts
status: open
---

## Problem

The production browser-chip semantic test accepted two browser-start messages,
but its selected conversation continued to show zero chips. Both API writes
returned 201, and both messages existed durably. The user turn had already
completed, so completion backfill had correctly stopped.

## Diagnosis

`POST message → committed Message row → HTTP broadcast queue → Supabase broker
→ selected-agent subscription → lifecycle chip`.

For root `9a268261-9e28-4ca5-8141-b233db14f8ce`, the canonical answer completed
at 01:33:51 UTC. The last selected-detail read was at 01:34:11.842. The two
browser-start writes succeeded at 01:34:15.736 and 01:34:15.901. Their batch
failed at 01:34:19.090 after its existing 2,001 ms attempt timeout. The publisher
had spliced this batch out of its queue and neither retained nor retried it.

This is a demonstrated defect in the HTTP delivery path, not proof that it is
the sole cause of the production UI failure. A read-only production catalog
check at 02:02:43 confirmed enabled Agent and Message triggers calling
`realtime.broadcast_changes`. Actual delivery on that independent path was not
captured. The trace establishes accepted writes and missing UI visibility;
exclusive attribution remains an observability gap.

## Archive search

Searched `supabase broadcast timeout batch dropped` and
`saved messages missing browser realtime update`. This is a relative of the
July one-shot snapshot and stale-token cases, with a different first-bad
boundary. The April INSERT deduplication case is directly relevant to uncertain
send outcomes: successful delivery can precede loss of its acknowledgement.

## Solution

Command, unchanged before and after the runtime repair:

```bash
cd back-end
npx tsx src/tests/blackbox/run.ts committed-message-broadcast
```

Before editing the runtime, the permanent owning blackbox failed because an
accepted-but-unacknowledged committed INSERT was discarded, and a stalled
request prevented another agent's notification from delivering. Its ephemeral
stream no-retry control passed. The first patched run passed these same three
checks. The final byte-identical ten-case artifact passes through the canonical
blackbox runner and passes only one case on baseline `0008aa8de`. These cases
also cement finite capacity, exhaustion, retry concurrency and independent
initial request slots. The same-topic ordering regression failed on the first
parallel candidate (nine of ten passed) before topic leases were added.

Committed INSERTs retain their original message ID and frozen payload in
per-agent FIFO lanes. Transient failures receive at most three sends, each
using the existing two-second request timeout. Permission errors are not
retried. Ephemeral stream events retain their existing one-attempt behavior.
Capacity rejection and exhausted delivery are logged with the owning topic and
message ID. This process-local queue is not a crash-durable outbox and cannot
guarantee delivery through a sustained provider outage.

The frontend claims repeated INSERT notification IDs before any cloud-mode,
stream, message-array or listener side effects. Claims survive a reconnect for
the selected conversation and reset when selection changes. Snapshot-loaded
messages do not seed these claims: their first notification must still settle
the matching live stream. Late browser-start notifications retain the existing
terminal lifecycle precedence.

An additional unchanged reproduction failed before fixing delayed first plan
acknowledgements: old completed plan X cleared a newer plan Y when X's first
successful notification arrived after its retry. Plan settlement now matches
`toolCallId`, as attention settlement already does. The owning INSERT handler
and its existing tests were extracted into smaller modules to satisfy their
existing lint limits; assertions remain intact and the matching-plan fixture
now includes its real tool-call identity. All 32 focused handler/delivery checks
pass after this correction.

The same first-delivery case also affected assistant rows that lack a stream
ID: fallback cleanup removed newer bubbles for the same subagent. A permanent
regression first failed with an empty bubble map. Fallback cleanup now preserves
streams whose producer start time is newer than the persisted message, while
the explicit stream-ID path keeps exact matching. The unchanged regression
passes after that correction. Legacy rows without usable timing retain their
previous cleanup behavior.

The frontend permanent reproduction is
`front-end/src/tests/blackbox/hooks-lib-insert-delivery.blackbox.ts`; the same
notification scenarios fail on the baseline and pass after deduplication.
This causal proof does not substitute for unchanged semantic outcome proof.

## Scale and remaining verification

There are no extra channels, production database queries, polling loops or
cross-agent topics. Notification queues and retry permits are bounded in
256 accounting shards, with independent per-agent ordering. Each shard admits
at most 128 lanes and 1 MiB of pending payloads. Initial topic queues admit at
most 64 messages/256 KiB; committed queues at most 32 messages/256 KiB. Initial
HTTP concurrency is 64, with batches of at most 100 messages/1 MiB. Each shard
allows four retry requests. A 30-second age bound controls dispatch eligibility,
with explicit age-expiry receipts. Request slots and topic leases release at
the initial HTTP outcome, before the per-agent retry lifecycle finishes.
Linked ready-topic queues avoid scans across agents. The UI retains identities
for only its selected conversation, alongside that conversation's transcript.

Full deployment gates, immutable-head review and production outcome verification
remain pending. A funded unchanged production rerun passed the browser-chip
test but failed a different realtime channel-join test; that failure is being
investigated independently. The original Google session acceptance remains
outside the proof of this delivery repair.

## Human feedback

Preserve the approved router and semantic deadlines. Fix the owning boundary;
do not turn selected conversations into indefinite polling loops or claim a
finite in-memory retry queue provides durable delivery.

## Reusable lesson

A failed acknowledgement does not prove a committed event was undelivered.
Keep retry ownership isolated, finite and observable, and make notification
consumers idempotent before retrying uncertain outcomes.
