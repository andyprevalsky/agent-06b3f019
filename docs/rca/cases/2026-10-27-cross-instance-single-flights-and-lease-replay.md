---
id: 2026-10-27-cross-instance-single-flights-and-lease-replay
date: 2026-10-27
title: In-process single-flights, a local-only /clear abort and a replayed lease INSERT broke N>1 backend instances
surface: back-end
component: shared-state
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src in-process coordination (sms-webhook clearSmsSession left lastInboundSeq unchanged, authOptions.ts identityMints Map, computeGrantRemint.ts inflight/cooldownUntil Maps, steel/sessionIdentity.ts inFlight Map) and sharedState.acquireLease rejecting its own committed row when the Prisma query retry replayed it
symptoms:
  - "A's run must not reply after B cleared the session"
  - "both instances must be told the stored identity"
  - "the account must be re-minted once, minted 2x"
  - "B released A's in-flight session"
  - "a fresh message must not be skipped as a duplicate"
tags:
  - multi-instance
  - scale-out
  - shared-state
  - render
  - lease
sources:
  - memory:scalability-audit-100-seats-20261024.md
repro: back-end/src/tests/blackbox/multi-instance.blackbox.ts (two Node processes, one local Postgres; lost-ack TCP proxy for the lease replay)
status: fixed
---

## Problem

S9 (`2026-10-26-process-local-state-breaks-multi-instance-backend`) moved
request state, locks and cron claims into Postgres. Its follow-ups named more
sites that still coordinate only inside one process. With two Render
instances each would misbehave:

- An SMS `/clear` aborted supervisor runs only on the instance that received
  it. A run on the other instance kept going and replied after the clear.
- Two instances serving one user's browser agents could each mint a
  replacement agent identity. Each was told a different inbox than the one
  that was finally stored.
- A revoked compute grant seen on two instances was re-minted twice, once per
  instance. The failure cooldown was also per instance.
- Every instance shares one Steel ownership marker. A reaper on instance B
  could release a session that instance A was still setting up, because the
  "in flight" set lived in A's memory.
- (S9 follow-up) A WhatsApp dedupe claim whose INSERT committed but whose
  reply was lost (P1001/P1017) was retried by the Prisma query extension. The
  retry hit its own row and reported a fresh message as a duplicate, which
  dropped the message.

## Diagnosis

Each case was reproduced in `multi-instance.blackbox.ts` on unchanged code.
Each simulated instance is a separate Node process (its own module memory)
running against the runner's database:

- `sms-run` + `sms-clear`: A records an inbound SMS (mySeq), B clears, and A's
  commit gate `inboundSeqStillCurrent` still returned true.
  `clearSmsSession` reset `messages` but never advanced `lastInboundSeq`, so
  the only cross-instance supersede signal was never sent.
- `auth-mint` ×2 on an identity with a retired domain: both returned different
  emails (1 of 3 runs; a timing race).
- `grant-remint` ×2: two replacement `ComputeGrant` rows.
- `steel-setup` on A + `steel-reap` on B: B released A's session.
- `wa-dedupe-lost-ack`: a TCP proxy in the child drops the connection on the
  first `INSERT 0 1` CommandComplete. The client must use `sslmode=disable`
  for the proxy to see it. The `$allOperations` retry re-ran the INSERT, and
  `ON CONFLICT ... WHERE expired` returned no row, so the result was
  `duplicate: true`.

Evidence logs are in `/project/s16-evidence/` (fail-before and pass-after).

## Solution

- `clearSmsSession` increments `lastInboundSeq` in the same upsert. Every run
  on any instance then fails `inboundSeqStillCurrent` (extracted from the
  closure in `handleSmsSupervisorMessage`) before it writes or sends. The
  local abort stays as a fast path.
- `ensureMintedIdentity` returns early, without taking a lock, when the
  identity is complete. Otherwise it mints under
  `withSerializedLock('identity-mint:<userId>')` and re-reads the identity a
  peer may have just stored. The in-process Map still coalesces callers on one
  instance.
- `ComputeGrantReminter` takes a `RemintCoordination` (in-process default for
  tests). Production serializes per account with `withSerializedLock` and
  stores the cooldown in `SharedEphemeralState`. The holder returns
  `coalesced` with the peer's grant when the active grant is no longer the
  dead one.
- The Steel in-flight registry writes `steel-in-flight` rows (20-minute TTL).
  The reaper and candidate cleanup query only their candidate ids
  (`liveEphemeralKeys`), merged with the local Map.
- `acquireLease` also matches `value->>'token' = <this token>` on conflict.
  The token is minted before the statement, so a replay keeps its own claim.
  A different holder's live claim still wins. This applies to every lease
  user, not only WhatsApp.

10k agents: every key is per user, per account or per session. No query scans
more than its candidate list, and the common identity path adds no query.

Still open, in a follow-up PR: the local-device hub, project workspace
executors and local Claude Code sessions. They hold live sockets and child
processes, so they need owner-instance routing rather than shared rows.

## Human feedback

Parent (2026-10-27): ship the five verified fixes on their own if the
process-affine routing would take more than about 3h; continue the rest in a
second PR.

## Reusable lesson

A per-process `Map` used as a single-flight or "in flight" registry is a
cross-instance bug once a second instance exists. Either move it to a keyed
lease or row, or make the cross-instance signal (here, a sequence number)
part of the durable write. Any insert-if-absent claim that runs under an
automatic retry must recognise its own earlier commit, or a lost ack turns
into a false conflict.
