---
id: 2026-10-28-it10-canary-boot-config-408-before-admission
date: 2026-10-28
title: It10 parent canary receives repeated boot-update 408s and aborts before workload admission
surface: infra
component: cloudbench-boot-config
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Both original and replacement Machine boot-config updates receive three exact-ID HTTP 408 responses; underlying provider/host cause remains unproven
symptoms:
  - "canonical parent N2 failed before worker admission"
  - "replacement Machine 683e3d0fe96458 also hit an unresponsive Fly host; no second replacement"
  - "boot config failed before barrier release"
  - "request returned non-2xx status: 408"
tags:
  - it10
  - i33
  - infra-canary
  - pre-admission
sources:
  - commit 82f06409be766f75bbc1b93c194457dfce80625e
  - fleet run 20261028-181750-1195
repro: none-recorded; immutable log/source trace only
status: open
---

## Problem

I33 is separate from I32's recovered controller seal read. It covers the
shard00 cohort c001 parent infrastructure canary, fleet20261028-181750-1195,
with browser-auth-saved-password-retry and
browser-doordash-food-plan-grocery-cart-reauth. The canary runs in infra-probe
mode before workload admission; its log explicitly says no LLM/run_benchmark.
Do not treat these two canary rows as original benchmark tasks.

The first normal-export sanitized subset SHA256 is
9e1c661c8f12993f81c8c43f18f0407e1d678ecd254edc353815f7ac938409cf.
All included SHA256SUMS entries validate. Its execution-provenance binds
base_sha82f06409be766f75bbc1b93c194457dfce80625e and workspace_patch_sha256=none.
The owner reports it came from a manifest-verified controller export; this
investigator has the sanitized subset, not the full original export manifest.

Cohort abort.json records18:26:30.919489Z, reason canonical parent N2 failed
before worker admission. Shard summary records24 jobs, all cancelled, all with
empty attempts and no started_at. These24 therefore have no scored task result
or independently confirmed task infra from this canary failure. Parent reports
the global70 original slots remain unscored after coordinated abort. Preserve
that distinction and all original clocks.

## Diagnosis

Observed path: clone -> boot-config update -> exact-ID408 threshold -> one
owned replacement -> repeated408 threshold -> strict barrier failure -> parent
canary failure/cohort abort -> cleanup attempts. No general code repair is
established; the deeper provider/host cause remains OPEN.

The original local evidence gives this table:

| Owner/phase | Recorded observation | Limit of evidence |
| --- | --- | --- |
| Original doordash clone80d222a6313508 | primary.log records creation; preflight records host-unresponsive replacement; marker names the old ID | Later archived first-attempt log confirms three exact-ID408 responses; physical host identity remains unknown |
| Replacement683e3d0fe96458 | cloudbench-boot-update.log records HTTP408 at18:23:31Z,18:24:45Z,18:25:59Z, each naming this VM | Provider response proves timeout refusal, not physical host identity or root cause |
| Replacement policy | preflight records no second replacement, then1/2 ready and barrier abort | This follows an explicit existing limit, not an inferred bug |
| Auth canary830374f7645d38 | fleet-child says Terminated, no published status proxy, original exit125 | Cancellation/cleanup evidence does not prove an independent startup cause |
| Cleanup | logs request destruction for three clones; three volumes show waiting_for_detach through reconcile4/6 | Later native audit reports no listed Machines but released=false and no guest-volume IDs checked |

A subsequent existing-file packet, SHA256
a713fd806f540a89661180fdc03c0369ebe198638c2dbdbb732f7aa2f5cb9be3,
contains the archived original attempt and native audit. Its supplied checksums
validate. Original80d222a6313508 returned408 at18:19:38Z,18:20:52Z and
18:22:08Z, request IDs01M61VRE52YB658W8CA464N89P-iad,
01M61VTPETVP3XS9KNR4DC4N62-iad and01M61VWYM6RBDR8EEKPH88HSDS-iad.

Exact replacement response request IDs are
01M61VZHX7FP5AY7VT5JQPF41E-iad,
01M61W1T3PDEVYHQ2HXJ8WHQN0-iad and
01M61W428T1DJ4B6S5Y4CCX46Y-iad. All are recorded with rc1. A different Machine
ID does not prove a different physical host; this packet supplies no native
physical-host identity or provider explanation.

Source82f behavior matches the observed failure boundaries:

- run-bench-cloud::boot_update_with_capacity_recovery counts only consecutive
  408 messages that name the exact BOOT_UPDATE_MACHINE_ID. Default threshold3
  writes boot-config-host-unresponsive and returns failure. Generic429/5xx are
  not promoted into this host marker. Existing native mutation pacing and
  per-command deadlines remain separate.
- run-bench-fleet::fleet_replace_host_unresponsive_child allows one replacement
  only for an exact-owned disposable clone, retains the old clone for teardown,
  moves original attempt files into host-replaced-<mid>, and relaunches the same
  slot. An existing boot-config-host-replaced marker refuses another replacement.
- The preflight log shows replacement actually happened, so the earlier
  autoscaler replacement deadlock is not established here. Infra-probe skips
  per-bench autoscaling. The second failed readiness prevents release rather
  than allowing an unready guest to execute tasks.
- run-bench-campaign's parent N2 branch aborts the startup cohort when its
  canary process does not pass. It writes the reason above and never reaches
  the pending-job launch loop for this cohort.

The current canary _batch/lifecycle.json is failed with controller_exit_code1
and empty audit_sha256. disposable-cleanup.json says guest_cleanup_missing=true,
runtime_evidence_missing=false and successful_runtime_inferred=false. These
receipts do not prove full release. A later native-release-audit.json at
epoch1793213137.722 reports no listed checked Machines, but released=false,
retained_owners contains the canary owner, and checked.guest_volumes is empty.
Its empty present_volumes therefore does not establish absence of the three
known volumes. Exact fleet audit rows mark destroyed-provider-retained and
meta remains incomplete with a retained hub ownership transfer required.
The auth child lacks status-proxy
cleanup acknowledgement; the doordash path reports boot config was never applied.
Do not make either unknown cleanup state into successful release or task infra.

The sanitized _batch/run.json is not parseable: JSONDecodeError extra data at
line46. Its checksum matches the supplied packet, but that does not show the
original producer emitted invalid JSON; redaction may have removed keys. It was
not repaired or used as an authoritative outcome denominator. Provenance,
summary, task matrix, lifecycle and report-card JSON parse normally.

Archive searches after original evidence intake:
`boot config host unresponsive replacement` and `Fly machine update 408`.
Read the prior fixed cases2026-10-26-fly-unresponsive-host-same-machine-update-replay
and2026-10-27-autoscaler-deadlocked-fleet-host-replacement. The bounded one-clone
replacement they discuss is present and executes here. Their existence does
not justify unlimited replacement, changed timeouts or another retry policy.
I32's earlier seal error has recovered and is not established as this cause.

## Solution

No runtime or task change proposed/applied. Do not extend retries or deadlines,
weaken canary/barrier admission, auto-classify all cancelled jobs as infra,
replace credentials, or repeat provider actions from this investigator.
The source behavior appears consistent with its bounded fail-closed contract;
a provider request timeout alone does not establish an owned defect.

Requested and received only existing local normal-export files: original
host-replaced-80d222 boot/fleet-child logs and markers, plus already captured
native cleanup receipts. Remaining capabilities needed to close this case are
authoritative provider explanation for the408s and owner-controlled complete
volume/retained-owner audit. No new provider probe was performed here.
No broad test or synthetic fix was run because no causally testable repair is
identified. Future fix work must first sync an isolated branch while retaining
82f as the causal baseline, then meet registered red/green and independent
strong-review requirements. Original70 unscored slots and canary failure remain.
Own tokens are UNMETERED; no provider/model/browser/DB/controller call, paid run,
image output, deployment or active operator change occurred.

## Human feedback

Parent explicitly separated I33 from recovered I32 and required immutable
native evidence before diagnosis. It prohibited blanket transient fallback,
retry/cap/timeout/task changes and denominator reinterpretation. Final resource
release remains unknown until owner's native audit; parent controls recovery.
Earlier family cases stay on their separate branches.

## Reusable lesson

A bounded recovery can run correctly and still end in provider failure. Preserve
original attempts, distinguish refusal after the configured replacement from a
missing replacement bug, and keep pre-admission canary failure separate from
unexecuted workload outcomes and unfinished teardown evidence.

## Later physical closure, without historical repair

The owner subsequently executed the qualified I34 GET-only observer and full
consumer. Projection SHA256
72cb499911cd7d4a160a6ea76d1d99fafc2ae1e7d34a8ee3c618cd9a064c5f6e
at epoch1793214705.1999094 verifies all20 original-scope resources terminal:
10Machines in destroyed state and10Volumes in pending_destroy, all retained
provider records, not absent resources. Original audit, runtime and task claims
remain unchanged. See the separate I34 case for source repair and exact evidence.
This closes the current physical-resource observation gap described above; it
does not identify the underlying408 cause or create task outcomes.
