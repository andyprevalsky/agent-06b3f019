---
id: 2026-10-29-it18-bootstrap-readability-and-undelivered-cleanup
date: 2026-10-29
title: Both canary bootstraps became unreadable before the barrier and retained unconfirmed cleanup
surface: infra
component: cloudbench-bootstrap-relay
classification: unresolved
problem_class: other
first_bad_boundary: Both original status routes stopped delivering bytes after git-fetch; the guest or transport cause is not captured
symptoms:
  - Five bench-log reads failed at offset360
  - Shared status readiness timed out with HTTP000 and curl28
  - Guest shutdown was not delivered and exact stopped ownership was retained
tags:
  - r64
  - it18
  - bootstrap
  - relay
  - cleanup
sources:
  - commit b0e4e9abb3f8d2a54db4bdff9b4f1f11f6fda644
  - plan: original startup archive 9d7194020e0dc2508888e52fd19e3a6eaf92ae79535dd7be06fb817afa228204
  - plan: original retained archive 9e5907442e2eed97d79d21ddd88f17c5023d8592fd19441e1103d1e3955f82fb
repro: Original startup and retained-owner records; no new execution
status: open
---

## Problem

It18 finished at 2026-10-29T06:01:30.360242Z with all twenty original jobs
cancelled, no admissions, and peak concurrency zero. Both prerequisite canaries
failed before the start barrier. Fleet `20261029-055405-950305`, owner
`336671c2816e471992b23c8cc2260772`, retained two exact Machines and volumes after
undelivered guest shutdown. The failed lifecycle and empty audit SHA are not
changed. The later observation was not backdated to the missed checkpoint.

## Diagnosis

Independently verified all twenty-four startup and fifty-seven retained-owner
members against supplied byte counts and SHA256s. Both original 360-byte driver
captures end after successful git-fetch, taking27 and29 seconds. Source next
resolves FETCH_HEAD, checks out and resets, but no captured result proves whether
that work stalled, finished, or failed. Five later reads of each log at offset360
failed. Recreated shared status routes reported deadline, HTTP000, curl_exit28,
and proxy_alive=true. Lease liveness does not prove a healthy end-to-end route.

The boot source starts its separate status service before bootstrap checkout.
Consequently an inferred checkout stall alone would not explain unreadable
status health. The supplied records do not establish guest death, broker failure,
a second WireGuard peer, or a provider cause. Prior shared-relay environment and
peer-conflict cases are comparators, not established recurrences.

Original guest-native-stop records bind Machines8577919c4eee78 and801674c602de18
to volumes vol_vxmqeljx3jd0eqj4 andvol_vwno5gwxmyd3ldqv. Their historical stopped
state is not guest-cleanup acknowledgement or a current native observation.
The canonical audit is incomplete. The registry's retain policy plus its
present guest-cleanup-unconfirmed latch is QUARANTINED under the actual source,
not a plain retain refusal. Runtime-evidence-missing is separately false.

## Solution

No runtime repair is justified from the current original evidence. The existing
exact-owner recovery route validates identity, topology, donor protection,
dead-controller birth and locks, then enters authenticated guest cleanup for
quarantined owners. Supplied custody contains no sealed guest provider manifest,
state, quiescence or recovery receipt. Stopped state alone cannot satisfy that
contract; the source directs such cases to original-volume capture.

That existing capture is a separate operational capability, not performed here:
it validates the exact original Machine/volume, saves the configuration, uses an
inert command to read original data, then stops and restores the exact config.
It does not rerun the task or release resources. Only validated captured evidence
can support later cleanup. Missing files must remain missing; no ACK or provider
absence may be invented. Current startup cause and operational release remain
OPEN. No timeout, retry, task, provider or ownership guard is changed.

## Human feedback

The coordinator required first separating bootstrap observations from lost
transport and undelivered cleanup. An early shorthand that retain implied
immediate recovery refusal was corrected by opening the quarantine predicate.
No provider/native/API/model/browser/DB calls or new capture were made by this
investigator. Tokens UNMETERED.

## Reusable lesson

A live relay lease is not evidence of a readable guest. Keep missing transport,
unknown guest progress, native stopped state and authenticated cleanup as
separate facts, and preserve the exact recovery latch until its evidence exists.

## Same R64: terminal native observations and local classification adapter

Both local capture next-step checks subsequently refused: the original canonical
fresh records were already destroyed-provider-retained, rather than owned.
This corrects the prospective capture discussion above; no capture or relaxed
owned predicate was used. Four separately authorized exact native GETs found
both Machines destroyed and both Volumes pending_destroy/unattached. These are
provider-terminal objects, not absence. The original destroy intent/ACK and
volume-creation identities were supplied privately. Independently reopening the
four recorded bodies and original identities satisfied the existing terminal
predicates for all four resources. No original app-authority GET was captured,
so this is not a complete fresh observer execution.

The remote forensic observer requires a verified disposable-controller export
envelope. This local controller has no such envelope; fabricating one would
misstate custody. The scoped adapter instead reuses the exact terminal-owned
resource validator, adds dead same-host local ownership and original source/
complete membership checks, holds the canonical shared recovery guard, and
revalidates the custody before private atomic publication. Its separate receipt
records physical closure only. The optional existing operator-preflight consumer
reopens the full custody and enforces the original inventory freshness bound.
It never clears registry, guest ACK, runtime, provider-session or task claims.

The existing fleet stale reconciler already skips retained/quarantined owners.
An actual-source control verifies that this owner does not block that function
and triggers no native call. The new consumer supplies the missing operational
physical-state classification; it does not bypass a previously blocking fleet
codepath. External provider readiness and capacity checks remain mandatory.

Fresh independent review first rejected V1 because freshness began at the end
of collection. The permanent delayed-response control demonstrates the flaw:
with original TTL1s, an early Machine read aged2s was incorrectly accepted.
V2 anchors freshness before the first GET and rejects an expired collection
before publication. The same control fails on V1 (ValueError not raised) and
passes on V2. Full V2 owning suite:8PASS. Existing remote forensic23 and
operator-preflight2 controls passed; their code bytes are unchanged in V2.

Fresh C review marked exact patch
`89b80383405be8966b9ac738beae4da9c700ac0b5402e85c0ab5204d808225d0`
GROUNDED. Personally opened references were OpenClaw stale-lock-file.ts48–94,
Codex app-server-daemon/src/install_lock.rs62–95, and Hermes
_subprocess_compat.py652–678 for conservative dead-owner/lock semantics; their
broader stale-lock removal is not copied. Existing Rose terminal validators and
owning controls establish native identity behavior. No model prompt changed.

Operational publication under the qualified code remains pending. It requires
one fresh app-authority GET plus the four exact resource GETs, then the explicit
local preflight consumer; stale or changed evidence fails closed. No native
operation was performed by this author. The original startup cause, missing
cleanup ACK, failed lifecycle and twenty cancelled/unscored jobs remain intact.
