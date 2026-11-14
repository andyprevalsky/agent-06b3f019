---
id: 2026-10-28-it11-bu059-finalization-crosses-activity-deadline
date: 2026-10-28
title: It11 BU059 credential finalization crosses the browser activity deadline
surface: harness
component: browser-finalization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Browser success message precedes synchronous credential propagation that returns after the authoritative activity deadline
symptoms:
  - Successful browser completion message precedes StartToClose timeout
  - Credential propagation returns HTTP 200 after the parent reports failure
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent 74675f6e-8cdb-4261-b45f-e06f4b71e88f
  - fleet run 20261028-201313-3991166
tags:
  - r25
  - it11
  - polar-bu-059
  - credential-finalization
repro: none-recorded; original source-bound event timeline and ownership inspection only
status: open
---

## Problem

Scope is only root74675f6e-8cdb-4261-b45f-e06f4b71e88f on executed
66eb9ccc4e39237bdd99b08f697180c7097a39bd. BU052r2/BU055r2 remain separate.
One latest-main fetch found7689c42637 plus prior5fedf69abb: two factory-history
commits/18 JSONL rows only, no runtime/dependency/schema delta. No draft runtime
was produced, so no integration merge, DB refresh, or active source change.

## Diagnosis

### Exact observed sequence

Normal archivea1ca78190df60d7022252ebfcbe7a656c91c6cb554f8b374bfb41fde4dbf2e2e;
run d8fb7679854d95127021a4ddf2ec2f6a81514d2d172859f5905b1f714ea83c41;
worker7b43b22a446d0d8f28ee2d54060e2845bcb0e9a2e27d8841962b806f1531c72b;
backend3b341fe8a645ec23e044e467941a151cdfb84cfb42ab2d5e909f85d6cb0e573f.
All normal members verified in initial R25 intake; original taskFAILED/infraFALSE.

- Browser verifier finishes successfully21:12:11.369819Z.
- Original FINISHED task_complete is persisted21:12:23.984Z.
- Credential progress starts21:12:24.022Z, backend POST begins21:12:24.080Z.
- The workflow's browser_activity_wait times out21:12:29.551574Z after2999989ms.
- Browser manager reports activity StartToClose timeout; root fails.
- Backend completes the SAME agent/task credential request with outcome=success,
  refs=2/applied=2 at21:12:33.219Z; HTTP200 at21:12:33.220Z, duration9140ms.
- Original activity handles cancellation/cleanup and ends at21:12:40.056135Z;
  the recording-upload/cleanup events are not an activity success return.

The recorded task-complete message is not the workflow's final typed success
receipt and does not establish all three benchmark rubric passes. No regrade.

### Owning source and duties

handler.py11861-11917 closes the browser with its cleanup receipt, disconnects,
checks unread instructions, saves task_complete, builds usage, then awaits
_propagate_browser_credentials_with_progress
before returning the visible successful result. The manager starts the native
activity with the existing calculated50-minute StartToClose limit at13685+.
The root joins that activity and requires its verified result. A saved message
alone is not the final authority.

repo.py354+ performs the credential POST synchronously with90s HTTP timeout.
handler.py2000+ catches ordinary propagation exceptions and emits unknown/error
bookkeeping while preserving the run outcome, but cancellation/outer expiration
is not an ordinary caught exception. Catching or shielding it cannot reverse an
already expired server-side activity deadline.

Backend credentialPropagation.ts285-400 authenticates/loads owner task messages,
extracts real credential references, classifies outcomes, applies them inside a
transaction keyed by agent:browser:task, and only then replies. The idempotency
marker prevents duplicate application; it does not create a durable queued job
or prove delivery after caller return. The existing post-run-hook blackbox
explicitly owns synchronous credential propagation. These are required
credential-state duties, not disposable logging.

service_activity_queue.py21-49 and the manager's WAIT_CANCELLATION_COMPLETED
preserve cancellation cleanup ownership. Existing sealed-generation behavior
must propagate; no fire-and-forget task may silently outlive that owner.

### Personally opened primary comparisons and contrary evidence

Codex core/src/thread_manager/shutdown.rs105-159 owns an explicit tree shutdown
handle, waits for every admitted operation, and states dropping a waiter does
not cancel owned cleanup. This supports explicit ownership/acknowledgement, not
claiming Rose already has that durable finalization protocol.

Hermes agent/deadline.py229-272 preserves the caller deadline and cancellation;
it warns that shielded scopes can wedge and uses a separate abandonment hook.
That is contrary to treating shield or swallowed cancellation as a valid repair.

Rose's existing credential propagation failure/redaction controls and backend
transaction marker reinforce preserving task identity, sanitized evidence,
updates and cancellation behavior. Archive searches found the October14 native
observation/credential-classifier evidence repair (different missing-input
boundary) and August22 Momence auth stall (different auth-routing proposal).
Their Solution/Human feedback were read; neither justifies an outcome bypass.

## Solution

The narrow cause is a successful browser path still awaiting synchronous
credential finalization when the authoritative existing activity expires.
That observation does not establish that the 50-minute budget is wrong or that
credential processing is optional. No safe local repair with the requested
constraints was established in this round.

An honest general repair would need a defined durable handoff and acknowledgement
contract separating completed task evidence from remaining finalization duties,
including ownership after timeout, idempotency, sealing, user cancellation,
credential delivery, privacy, usage and cleanup. Existing source has no such
handoff. Adding one is broader than a local catch/reorder. Returning early,
creating an unowned background task, widening50minutes, or accepting the saved
success message after timeout would violate the current contract.

No speculative test was written because it would encode that unapproved new
contract. The original request returned successfully after deadline; no lost
credential update is alleged. Missing proof is durable finalization ownership
and unchanged full-task outcome, not another live provider read. Parent should
retain OPEN until that general contract is explicitly scoped and supported.

No runtime changes, provider/model/browser/DB/native calls, images or paid run.
Tokens UNMETERED. Original grades, timestamps and release evidence unchanged.


## Human feedback

Parent prohibited fire-and-forget credential work, widening the activity limit,
or treating a persisted task-complete message as final task success. The
investigation stayed scoped to BU059, with BU052 and BU055 handled separately.

## Reusable lesson

Distinguish the time a success message is saved from the time its owner returns
an accepted result. Moving required finalization work requires an explicit
durable owner and acknowledgement contract, not merely an earlier success flag.
