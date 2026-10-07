---
id: 2026-10-06-sealed-cohort-repeated-canonical-fixture-get
date: 2026-10-06
title: Sealed campaign controllers repeat the same complete canonical fixture preflight
surface: harness
component: cloudbench-campaign-seed-preflight
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-fleet performs a complete host seed GET independently for every controller in the same sealed fixture cohort
symptoms:
  - fifty sealed controllers make fifty identical complete canonical fixture GETs
  - canonical preflight has no cohort-owned completed validation receipt
tags:
  - cloudbench
  - campaign
  - fixture
  - full-get
  - ownership
sources:
  - commit 5233c125258139b2c71a7d35a8a39d7f30d02984
  - agent /root/fresh_claude_grouped50_cli
  - plan:.context/fresh-claude-grouped50-20261006/cohort-fixture-dedup-packet/review.safe.json
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: open
---

## Problem

The real TypeScript seed client, directed to a loopback object store, completed
fifty full GETs for fifty controllers in one strict campaign. All controllers
exited zero. The new owning assertion failed on the unchanged scheduler; the
private candidate completed the same fifty-controller control with one GET.
A standalone fleet still made its separate GET. No HEAD was issued.
This proves redundant host transfers, not a historical startup-time cause,
benchmark outcome, production latency gain or LIVE acceptance.

## Diagnosis

Campaign membership → per-controller host fixture preflight → repeated complete
GET → guest startup is the path. The first bad boundary is the identical host
GET independently repeated inside each fleet despite the parent already owning
one sealed source/fixture cohort. The deepest proven cause is the absence of
cohort-owned prerequisite validation at admission. Guest GET, sidecars and
actual database restore remain distinct mandatory work.

Archive searches were `canonical seed dump campaign preflight` and `repeated
full GET cohort shared fixture`. Failed-canary failure fanout and premature
strict-cohort release are relatives with different first bad boundaries; no
recurrence or historical 1414.4-second stage attribution is established.

## Solution

Factor the unchanged full GET runner and prepare one private completed receipt
before admitting a strict cohort with its existing live inventory owner. Bind
consumption to existing owner identities, parent lock, stable job membership,
published controller PID, source/schema/PG/cache token, runner code and storage
scope identifiers. Secret values and hashes of secrets are excluded. A
legitimate prepublication PID waits within the existing startup deadline;
missing or foreign proof fails closed without another GET. Failed publication
admits zero controllers and joins the owned feed. Standalone and non-strict
paths retain their own complete GET. No timeout or result contract changes.

Delete/unify evaluation: delete repeated cohort transfers and unify their
existing runner; reuse existing membership and process-identity primitives
instead of introducing another owner registry or storage client. Root review
caught Linux proc-start matching and parent PATH side effects in intermediate
candidates. Final source reuses the existing format-dispatched matcher,
retains parent Node/npm resolution on both paths, and streams receipt hashing
in bounded chunks. Native Linux positive/wrong-tick/legacy controls pass in the
unchanged offline image; parent PATH has unchanged RED/GREEN proof.

Root independently verified eight family passes plus a Linux-specific skip and
the parent-PATH control. Formatting and source-relative Ruff checks pass; all
function ASTs are unchanged by formatting. Exact commands, hashes, scalar
receipts and retained rejected revisions are in the private packet. Existing
`campaign_inventory` compact-gate selection discovers these tests. Integration,
checked-in archive indexing, native Linux gate routing and real fleet timing
remain root-owned and pending, so status stays open. No benchmark definition,
fixture, prompt, evaluator, guest restore, budget or source checkpoint changed.

## Human feedback

None recorded for this specific deduplication repair. Root technical review
required unchanged full GET, existing ownership/membership reuse, delayed PID
handoff, Linux-native identity proof, bounded memory, parent PATH preservation
and no unmeasured startup-speed claim.

## Reusable lesson

Validate an identical sealed prerequisite once at its existing cohort owner, while preserving each consumer's native identity handoff and downstream restore contract.
