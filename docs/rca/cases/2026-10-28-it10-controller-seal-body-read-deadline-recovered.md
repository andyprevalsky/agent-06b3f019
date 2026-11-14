---
id: 2026-10-28-it10-controller-seal-body-read-deadline-recovered
date: 2026-10-28
title: It10 controller seal body read reaches its deadline and normal ownership recovery succeeds
surface: infra
component: cloudbench-disposable-controller
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Initial seal GET body read was interrupted by a controller action deadline before a complete response observation; transport cause and exact nested alarm owner remain unproven
symptoms:
  - "Deadline: controller action deadline"
  - "payload = response.read(256 * 1024 * 1024)"
  - "Machine allocation exists or is ambiguous; seal/export required"
  - "EXPORT_DOWNLOAD_REQUIRED_SEAL_RECOVERED"
tags:
  - it10
  - i32
  - controller-seal
  - recovered-transport-error
sources:
  - commit 82f06409be766f75bbc1b93c194457dfce80625e
  - fleet run original600-1793211288750841432 shard-00
repro: Existing offline recovery and deadline controls pass; no reproduction of original network failure
status: open
---

## Problem

I32 covers one recovered controller seal-action failure, not a terminal task
infrastructure failure. Executed source is82f06409be766f75bbc1b93c194457dfce80625e.
Original controller Machine48edd725c75348, instance01M61VK1M8YHTFGQ11TQ8743CH,
workspace volume vol_vdeop62m0ool19x4 remained owned while export was pending.
No task grade, scheduled denominator or original clock was changed.

The supplied redacted gate log (SHA256
678d3f09feb467f9323c1fe9377e6560a659cfd22761ef2de7875e56e36df8a9)
shows successful create/start followed by seal's GET /machines/48edd725c75348.
The traceback ends in Python3.12 HTTPResponse._read_chunked, SSL recv/read and
cloudbench-disposable-controller.py::bounded.expired raising Deadline.
The gate exits1 and retains the controller/workspace. Workspace-only cleanup
correctly refuses the extant or ambiguous Machine instead of deleting the volume.

Parent's corrected observation: the controller is not dead. Existing recovery
sealed ownership and left the caller runner live; a supervisor observation had
24 queued jobs, no task failures and zero confirmed task infra. Other gates were
live. Earlier parent wording calling this an authentic task infra was withdrawn.
Do not assign this action failure to23 or24 independent jobs or call the
benchmark failed from this gate exit alone. The original run remains70 scheduled
with its existing stop rule, not a denominator derived from this incident.

## Diagnosis

The first observed failing operation is a bounded GET response-body read.
There is no evidence of a safe general code repair or a reproduced provider
failure. The current failure handling and later seal recovery are functioning
in the supplied observations.

Owner's existing-file packet SHA256 is
892e37e2f3652944e5499aab7a96a61fce19a330b00c623b848795580421c741.
All9 included file checksums validate. Original mtime_ns values are preserved
as data in seal-observation-index.json, not reconstructed from extraction time.
The machine response bodies were intentionally excluded because config.env
contains private data; their sizes/hashes/status below are custodian-indexed,
not independently decoded by this investigator.

1. First seal volume request at18:15:40.508960Z has a completed200 observation
   at18:15:40.692961Z. The machine GET request file is written at
   18:15:40.696961Z. No corresponding machine raw-observation file exists in the
   supplied index. The gate traceback places interruption inside body reading.
   No complete status/body receipt was persisted for that attempt. Absence of
   that receipt is not proof the server never sent headers or partial bytes.
2. Cleanup-workspace subsequently reads the same Machine successfully. Its
   indexed raw observation is at18:16:02.165106Z, status200, body SHA256
   21fa64598e2e058e26d843cb7399dd4dceef657d88be32e127816424d0ff8323.
3. Recovery seal requests the volume at18:16:03.725117Z, receives200 by
   18:16:03.933118Z, then requests the Machine at18:16:03.933118Z. Its indexed
   completed200 observation is18:16:04.393121Z, approximately0.460s later,
   with the same body hash. The raw JSON observation wrapper is219491 bytes;
   decoded response body is164490 bytes. Do not conflate wrapper and body sizes.
4. The durable export-recovery-required receipt at epoch1793211364.4277015
   (18:16:04.427701Z) reports EXPORT_DOWNLOAD_REQUIRED_SEAL_RECOVERED,
   gate_exit_code1, export_verified=false, cleanup_owner_pid2712882 and
   benchmark_success_inferred=false. This proves neither completed export nor
   resource release, but supports progress through the existing recovery branch.

Source trace at original82f:

- run-cloudbench-controller-gate invokes disposable_controller seal after the
  create/start identity is obtained and before normal gate waiting.
- seal validates volume then GETs the Machine before saving the ownership seal.
- The helper's main runs under bounded180. Each native API attempt nests
  bounded20(reconcile_timeout=True) and calls Fly.api(timeout=20).
- Fly.api opens the response and reads its body before invoking observer. Thus
  a body-read interruption leaves the already-written request intent without a
  complete raw status/body observation. Socket timeout is not a whole-body
  duration proof; the outer signal bounds the operation.
- A fully received transient GET429/5xx may be retried under the existing policy.
  Here no complete response status exists; a Deadline is not CaptureFailure
  and is re-raised. No in-seal retry is evidenced or recommended.
- The shared error text does not distinguish the nested20-second alarm from
  remaining whole-action time. The observed interval is consistent with the
  per-attempt bound, but exact alarm ownership is not serialized in this stack.
- The runner catches refused workspace cleanup, resolves the exact create-intent
  name, invokes pinned recover_seal once, preserves the refused intent, and
  transitions to export download/probe ownership. Existing receipts show that
  path executed. This differs from the old missing-recovery loop defect.

Archive searches: `response read controller deadline seal` and
`chunked body read deadline`. Read the prior fixed case
2026-10-26-startup-deadline-controller-never-sealed-runner-spun in full.
That case added the recovery path now observed succeeding. Do not append this
as a recurrence of its missing recovery cause. Provider latency, packet loss,
chunk framing and exact socket progress are not captured well enough to name
one of them as the underlying cause.

## Solution

No runtime repair proposed or applied. Preserve existing fail-closed ownership,
read-only retry policy, export verification and cleanup refusal. Do not increase
timeouts, retry writes, repeat seal/provider calls here, restart the controller,
or infer task success/failure or resource release from the action error.

Existing offline contract controls on unchanged82f:

- original600-portable-operator: startup_deadline_controller_is_sealed_reprobed_and_released
  and startup_deadline_ambiguous_or_refused_seal_never_releases both pass.
- cloudbench-disposable-controller: whole_deadline_never_becomes_recoverable_delete_timeout
  passes.

These are two recovery controls plus one deadline control, not a new causal
red/green or a reproduction of the network failure. The recovery test emits
ResourceWarning for its fixture file handle; assertions pass. No provider call
is made by these mocked controls. The original action error is observed and
recovered; underlying network cause remains OPEN. Parent retains responsibility
for live controller/export ownership and any future run outcome.

No /sync or source mutation is needed for read-only intake. A later proposed
repair must first perform the required isolated sync while preserving82f as
original baseline, then establish a registered same-test red/green and exact
independent strong review before application. No repaired benchmark credit.

## Human feedback

Parent corrected the initial infra wording: this is a recovered seal transport/
action error, with no terminal infra job or proven benchmark-outcome failure.
It required one incident scope, original clocks, no native/provider/DB/model/
browser calls, no image output, no retry/deadline/policy guesswork, and no
active operator changes. Owner supplied existing local observations only and
withheld raw config.env bodies. Own tokens are UNMETERED.

## Reusable lesson

Distinguish an interrupted response body, a missing completed observation, a
retained ownership boundary and a later successful recovery. Neither a gate
exit nor a shared deadline string establishes task failure or identifies the
responsible network or nested timer cause.
