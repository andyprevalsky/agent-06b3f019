---
id: 2026-10-13-post-canary-admission-bypassed-parent-inventory
date: 2026-10-13
title: Post-canary admission bypassed the existing campaign inventory owner
surface: infra
component: cloudbench-campaign-inventory
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet reads Machines directly after fleet_infra_canary_preflight before borrowing the parent inventory feed
symptoms:
  - App capacity guard could not refresh machine state after infra canary.
  - infra canary preflight stamp fresh followed by controller exit before task allocation
  - campaign children repeat an app-wide Machines read despite a parent-owned inventory publisher
tags:
  - cloudbench
  - campaign
  - inventory
  - capacity
  - startup
sources:
  - PR #1482 checkpoint 609f65a05f95a8047584c5f6ceba6a16a6c597f1
  - fleet run campaign-20261012-222613-2892947 member r001-j0044
  - commit e7b0348ea9b21b1b12799e4d41e21e8db4b93ba4 resumed custody receipt
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: open
---

## Problem

The original restored r001-j0044 log records a fresh infra-canary stamp, then
`App capacity guard could not refresh machine state after infra canary.` Later
terminal Hub publication timed out. Its task was browser-opentable-reservation,
physical fleet 20261012-222628-2896286. The original campaign summary advertises
shared-inventory and publisher PID 2893851. Original execution-provenance names
base SHA 6e0b6e481f7099a149196de9b3368afccfce5474 and controller snapshot digest
6d79247283ace95fff2d21b7fee346c5bf8875c846325f124d70168a355747e3. The tracked
fleet, inventory library and campaign script at that base are byte-identical
to PR1482. Provenance also records a workspace patch; tracked equivalence alone
does not prove that the complete executed snapshot was identical. These are original historical
identities, not current local ownership or allocation authority.

PR1482's exact checkpoint contains deployment ancestry and a handoff, with no
finished herd implementation. This repair was developed anew from that source
in /home/boxes/rose-original-inventory-herd. The preservation checkout and private
originals remain untouched; no recovery, provider mutation or new trial ran.

## Diagnosis

Path: campaign-owned native inventory publisher -> controller post-canary
Machines observation -> native capacity/reservation guard -> primary allocation.

What: the controller makes a redundant direct Machines request before attaching
to the feed already owned by its campaign. Where: the warm_json assignment
immediately after fleet_infra_canary_preflight; admission retry repeats the same
independent read. Why: feed attachment occurs only after admission. Proof: the
actual post-canary caller and actual admission retry loop fail when parent reads
succeed but redundant child reads fail; both pass using the existing fenced feed.
Problem: duplicated read-only provider sampling across controllers. The deepest
owned repair is attachment/consumer ordering, not provider availability policy.

Archive searches used the literal capacity error and `shared inventory campaign
fanout`. The October 5 duplicated-publisher case and October 6 freshness case are
related leads. The October 5 repair deliberately retained direct native capacity
reads; this extends its existing feed contract into this pre-allocation consumer,
rather than claiming the earlier sharing tests covered this caller.

Golden-reference searches in the existing read-only claude-code-src, OpenClaw,
Hermes and Codex trees used flyctl, machines list and publisher_token. No analog
was found for this Fly campaign inventory mechanism. The repo's existing producer,
reader and process-birth fences are the relevant established contract.

Historical attribution remains open: native stderr at the failed direct read was
redirected away. Neither the exact native rejection nor its latency is retained.
Concurrent fanout can be reproduced, but a rate limit, credential failure or
particular Fly outage cannot be attributed to original j0044 from this evidence.
The independently owned later Hub timeout is not explained by this repair.

The permanent owning reproduction runs the real campaign scheduler, publisher,
borrower cleanup, sourced inventory library, actual post-canary caller and actual
admission-wait loop. Only the provider transport and downstream capacity sink are
controlled. The sink requires the unchanged native JSON payload. Shared mode
rejects redundant child requests; standalone mode permits its ordinary reads.
Existing capacity guard tests separately retain Machine/CPU reservations, pool
eligibility, cross-workspace serialization and start-accounting assertions.

Exact owning command, after activating the matching agents venv:

```sh
PYTHONPATH=agents python -m pytest agents/benchmarks/cloudbench_campaign_inventory_test.py -q -k post_canary_admission
```

The same final test bytes against an exact git-show copy of the checkpoint fleet
script produced 2 failed, 2 passed (exit 1). The two shared controls failed;
original child logs contain the original post-canary error. Unchanged assertions
against repaired source produced 4 passed (exit 0). Private logs are
.context/post-canary-inventory/red.log and green.log. The original-source selector
is CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST pointing to the private original directory;
The inventory library is also an exact git-show copy; other unchanged scripts
are linked source. This is offline causal proof, not
native replay of the uncaptured provider error or benchmark outcome proof.

## Solution

After the unchanged canary completes, attach campaign consumers through existing
start_machines_snapshot_loop, then obtain warm_json through fleet_machines_json.
Admission waits use the same reader. Standalone pre-admission reads remain live;
no standalone publisher starts before its reservation. Native capacity policy,
owner births/token/finite-expiry fences, reservations, pool claims and exact
post-mutation/release verification are unchanged. No prompt, task, provider,
timeout or evaluator contract changes.

This unifies the redundant read with the existing producer. The existing
300-second admission clock owns temporary feed re-observation; there is no new
publisher, fallback or deadline. Missing/stale feed withholds the native capacity
guard until a fresh generation arrives, or the same admission clock expires.
It never falls back to child provider reads.
Wrong token/app, changed parent/publisher births, absent owner/snapshot and rejected
standalone credentials also withhold admission. Borrowers never stop the parent.
The compact two-consumer controls observe two parent Machines reads, including
admission retries, versus six ordinary initial reads or eight with retries.
These are fixture counts, not measured production bandwidth or speedup.
At 10k controllers, this boundary adds zero per-controller provider calls in
shared mode; local JSON reads remain per-controller. Other direct preflights and
exact mutation/cleanup observations remain and are not claimed optimized.

Registration already includes this owning file and the campaign_inventory selector
in scripts/tests/benchmark-live-results.test.py, registered by
scripts/run-deploy-structural-gates.py and /deploy Step 4s. No new suite, live gate
or paid stage was added. Focused post-canary controls after parent review: 18 passed. Existing native
capacity regression selection: 13 passed. The ec436bad5 owning campaign suite: 56 passed. Its compact gate:
548 passed, 4 skipped, 851 deselected in 245.51 seconds (exit 0). After the
parent-requested re-observation repair, the compact gate produced 552 passed,
4 skipped and one expected trusted-source-review rejection in the pre-service
recovery fixture. The recipe fingerprint includes run-bench-fleet; registration
requires independent review of the final immutable source. No validator or
review-policy bypass was made. Final review and gate completion are pending. The gate log
and source/check receipts are retained under .context/post-canary-inventory.

The second compact-gate invocation exposed an independent fixture publication
race: 547 passed, one capacity-loop test failed, four skipped. Its retained native
receipt had 9/10 internal cases passing, every recorded owner absent, and zero
provider/model calls. inventory_expired_then_ready changed from retryable to
fatal while the Python fixture restored health by truncating the live file.
A permanent slow-write stimulus at that same fixture writer deterministically
reproduced the empty-file exposure: 8/10 internal cases passed, the test exited 1.
Restoring through a sibling temporary health file and atomic replace made the
identical command pass (10/10 internal cases; pytest 1 passed). Assertions,
production reader, process ownership and host/lifecycle bounds remain unchanged.
This follows the existing complete-payload fixture publication rule. The normal
capacity-loop owner retains that slow writer and covers the publication boundary;
private fixture-red.log, fixture-green.log and original failure receipts are under
.context/post-canary-inventory. The final compact gate passed after this repair, as recorded above.

This case remains open for original provider-error attribution and exact unchanged
benchmark outcome verification. The user prohibited paid tests and provider
mutations, so no canonical local benchmark or LIVE50 run was attempted and no
benchmark acceptance or deployment is claimed. Independent review belongs to
parent ph71gtg4ntdz4sd4xkzp8qqn2n8g7nss; no additional worker was created.

## Human feedback

Parent ph71gtg4ntdz4sd4xkzp8qqn2n8g7nss reviewed ec436bad5 and accepted the shared-read/native-guard shape, but identified premature exit on temporary status 75. The same live, birth-fenced missing/expired feed now has permanent RED/GREEN recovery controls: both fail on ec436bad5 and pass with re-observation under the existing admission clock. The reader preserves 75; admission interprets it as retryable only for an attached feed, so unclassified native CLI exit 75 remains fatal for standalone operation. Empty/malformed health, wrong token/app and birth corruption remain immediate failures. Unknown feed cannot call the guard, mutate or fan out. Final independent review remains with the parent; no new worker was spawned.

Continue on this devbox from exact original PR1482 source; do not reconstruct a
missing herd implementation. Preserve native resource/capacity admission, feed
ownership and lifecycle budgets; unknown native inventory withholds mutation and
never fans out on missing shared feed. Keep Hub repair separate. No paid tests,
provider mutation, claim deletion, merge, deployment, production env writes,
additional workers/devboxes, prompt edits or fabricated evidence. Preserve Freedom,
protected instructions and exact stopped38970c3 custody without duplicate recovery.

## Reusable lesson

Attach an existing parent-owned native inventory feed before its read-only admission consumers, while preserving fail-closed capacity and exact mutation ownership.


## November 8 recurrence: warm-volume selection bypassed the attached feed

PR #1770 source `7df366f750b44cc53abea9dc0ffb2167e637b3b5` launched
13 smoke tasks on November 8 at 07:11:11 UTC. Eleven passed;
`parallel-tool-calls` failed before task allocation and the native infra-stop
cancelled `test-mass-agent-run-0`. Both original controller logs ended with
`Could not find warm volume 'cloudbench_data'`. The campaign ended at
07:29:19 UTC. No parent signal or operator retry was used. The native cancellation
is distinct from an independently diagnosed second provider failure.

The warm-volume producer still executed raw `FLY volumes list` even after the
campaign inventory feed was attached. That producer and its exact WV/VN/WM
parser are byte-identical on baseline main `34c48f601f6aeb54c1fb80ceca023fe644b81912`
and the failed source (SHA256 `045b11d581f53494f9cc126f666d881ed0c1ee321caa647e6c3171c18b93e065`).
Gate: NOT_INTRODUCED for this bypass. The older ordering repair covered Machines
reads, but its test did not cover this later volume consumer. Archive searches
used `Could not find warm volume cloudbench_data` and `warm volume shared
inventory per-child live provider reads`; this is a recurrence of the shared-read
contract gap at a different consumer.

The original Fly read status, stderr and parser error were discarded. Empty
VOL_ID therefore does not prove that a volume was absent, credentials were bad,
or Fly was in outage. A later unchanged-auth bounded read succeeded with
127 JSON rows in 5.64 seconds; it is availability evidence, not reconstruction
of the earlier transport error. That historical attribution gap remains open.

The narrow repair routes volume input through the existing parent-shell
`campaign_inventory_capture` and `fleet_volumes_json`, then runs the unchanged
exact-volume/name/attachment parser. Shared mode uses the owned feed or refuses;
temporary status 75 retains the original admission deadline. No timeout, task,
concurrency, evaluator, capacity guard or standalone policy is changed.

A permanent actual-caller test fails on the old producer because it makes a
forbidden per-child provider read despite a healthy owned snapshot, then passes
unchanged after the repair. Controls retain publisher identity/freshness,
transient and expired retryable reads, fatal ownership errors, malformed JSON
and all eight original exact-volume parser assertions. The owning deploy gate
already discovers the new campaign_inventory-named test. Local test proof
repairs this routing boundary; it does not reproduce the uncaptured historical
Fly error or establish a canonical local benchmark outcome.

The final scoped inventory group passed 18 tests in 6.80 seconds; the exact
coordinator suite passed 219 tests in 59.242 seconds. Independent review
confirmed the final source and refusal controls. Full current-source deployment
validation remains required; this does not close the historical transport gap.
