---
id: 2026-10-29-it17-ambiguous-clone-cleanup-retained-owner
date: 2026-10-29
title: Ambiguous clone allocation retained exact ownership after an unsafe cleanup lookup
surface: infra
component: cloudbench-fleet-cleanup
classification: unresolved
problem_class: other
first_bad_boundary: Initial native clone returned an I/O timeout after volume creation; final name resolution was unsafe with its raw response unavailable
symptoms:
  - Canary cleanup failed after both native probes passed
  - All twenty original jobs cancelled before admission
  - Exact name and volume ownership retained without a machine ID
tags:
  - r63
  - it17
  - ambiguous-allocation
  - cleanup
sources:
  - commit 355f1a0855e4870e222ed9731ac858f89d7e11c7
  - plan: original cleanup archive b78c0c4078d31ba49b0d55b5b22b70cc48807b9bf2c4dd9b7939e8fcfbf94e03
  - plan: original allocation logs b8949364cb4b38f66b7e283423a44fd5a5284e0c78be597cf738ca256d4c3294
  - plan: original canonical audit b011c69ca9a19ab64b5a663bcea09ff974aedaebf24ffcf5cabc32f38e1b629c
repro: Original allocation, cleanup and canonical audit records; no new native execution
status: open
---

## Problem

It17's original twenty jobs were cancelled before admission. Two native canary
probes passed, but cleanup failed and the lifecycle remained FAILED with empty
terminal audit SHA. These are distinct outcomes: no benchmark task credit or
full resource release is established. Fleet `20261029-051145-399932` retained
owner `e1618b9c91cd4e108b12b851023ab276`. The original R63 investigation clock
starts around 05:35 UTC on 2026-10-29.

## Diagnosis

Independently verified all fourteen initial cleanup members, six allocation-log
members, and forty-two canonical audit/provenance members against their supplied
byte counts and SHA256s. The first allocation created volume
`vol_4oj6m9e8o67gjdqr` for name `cloudbench-9aab58fe0f4a4b76b132978b`, then native
Machine cloning returned an I/O timeout while launching the VM. The primary log
SHA256 is `994f7b5cb138724cf51c96a184aaca665db104d7c649a640d7059fc05ceb092f`.
No Machine ID was returned for this attempt. This is ambiguous allocation,
not proof that no Machine existed. A subsequent attempt used a different name
and succeeded; the other canary also succeeded.

Final cleanup reported an ambiguous/unreadable name lookup and retained the
original name/volume record. Its raw query response and exit status were not
retained in supplied custody, so transport failure, malformed inventory and
other unsafe-read branches cannot be distinguished. Existing inventory
snapshots are separate observations, not the failed query or current absence
proof. Known siblings have DELETE intents and audit dispositions; neither alone
proves complete release. Unlike the July 20 sibling-sweep case, current source
continues processing known siblings rather than returning at the first unknown.

The initial report of an empty audit was corrected: it inspected the missing
fleet-local terminal mirror, not the canonical shared audit. Original canonical
metadata is INCOMPLETE, with three expected-fresh records, three fresh records
and two Machine-index records. All bind this owner/run/app to donor
`683e47df5094d8`. The unresolved record has no Machine ID and retains its exact
volume. Source publishes this audit before allocation; the run-local mirror is
copied only after verified teardown. No missing-audit reconstruction is needed.

## Solution

No runtime repair is justified by this evidence. The existing
`--recover-stale-owner` route is a concrete operational plan, not an executed
recovery or release claim. It requires original audit topology, protected donor
identity, proven-dead same-host PID birth, locks, cleanup policy and existing
runtime/guest receipts. Its forced volume-only branch acts on authenticated
volume ownership without another name lookup; it must not be described as fresh
Machine-name absence proof. Exact native terminal checks, sibling reconciliation,
Hub custody and the final audit remain authoritative. Any refusal retains
ownership; no manual deletion, fabricated ID, missing-ACK override or blind
retry is proposed. Operational recovery outcome remains OPEN.

## Human feedback

The coordinator requested original evidence first, corrected the audit-path
confusion, and retained authorization over any native recovery. This investigation
performed no provider/native/API/model/browser/DB operation and changed no
runtime source. Tokens UNMETERED.

## Reusable lesson

Resolve the canonical audit path from the ownership record before diagnosing
missing custody. A missing success-only mirror is expected after failed cleanup.
An ambiguous allocation and a later unsafe lookup remain distinct unknowns;
retained exact ownership supports guarded recovery, not retrospective absence.

## Same R63: canonical operational recovery completed

The owner executed exactly one canonical recovery on unchanged source355,
using the original owner token and ordinary bounds. It exited0 at
1793252949.64495. The returned receipt reports registry removal and
provider-teardown-verified at1793252943. Original result archive SHA256 is
`3e99daf38d27a8cfc7e518c78243ec2cd8c74509cad4cc9917a1720b945d9e6c`.
Independently recomputing the supplied canonical audit and run-local mirror
produced the same digest as the mirror's source-audit binding:
`8f22bd8bc9018c12f6fbc7e4b8d14389321acb650a45d8fa7734ae7b9b5e309f`.

All three fresh records have disposition destroyed-provider-retained. This
is verified provider-terminal retention, not physical absence. The original
name-only record still has no invented Machine ID. The original lifecycle
remains FAILED with empty audit SHA, and all twenty original tasks remain
cancelled/unscored. The first allocation timeout and exact final unsafe-query
cause remain unresolved. Operational ownership reconciliation is complete;
no code repair, benchmark success or retroactive lifecycle rewrite is claimed.
