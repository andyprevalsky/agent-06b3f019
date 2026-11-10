---
id: 2026-11-10-semantic-classifier-rejects-native-retry
date: 2026-11-10
title: Native semantic retry results rejected by a single-attempt classifier
surface: harness
component: deploy-test-semantic
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_semantic.py classify_lane rejects two native attempts although the frozen Playwright config permits one retry
symptoms:
  - semantic-stack UNVERIFIED complete=false with all 63 cases executed
  - 60 PASS and 3 UNVERIFIED despite successful hooks on both failed attempts
  - len(results) != 1 discards retry0 failed and retry1 failed
  - native ui exit1 latency exit0 readytrue cleanuptrue errors[]
tags:
  - semantic
  - playwright
  - retry
  - deploy-metadata
sources:
  - commit 2390845cf087491b96e4d8ea83d16188f80f64bd
  - commit f8c8255003d70ac639facf623b30397d62baf38a
  - commit 58bdc6fadfcdc6553110006db20b740d8599fa02
  - commit 455c3335d74b879a26f1353864eee42d2332da75
repro: scripts/tests/deploy-test-semantic.test.py SemanticRetries; external immutable semantic38 artifact replay
status: open
---

## Problem

Actual native run 42749212512 on frozen2390845/digest50294f07 produced 58 UI cases
(55 passing, three failing on both attempts) and five passing latency cases.
The original aggregate is permanently retained as UNVERIFIED, complete=false,
native_exit=1, cleanup_complete=true, interrupted=false. It is not repaired by
replaying or reclassifying its artifacts. The three genuine sidebar failures
and all earlier post-merge packets remain evidence and retain their owners.

## Diagnosis

Path: unchanged Playwright retry policy -> native JSON and lifecycle reporter ->
classify_lane -> aggregate completeness -> worker/cycle accounting. Actual
ui.json/ui.jsonl preserve retry indices0,1 and the exact testBegin/Before Hooks/
After Hooks/testEnd sequence twice, successful hooks, identical test identity,
and failed statuses on both attempts. The old classifier discards them at its
single-result check; the single-four-event check would independently reject
them. No case is unexecuted and no cleanup failure explains the incomplete result.

Exact captured-artifact replay through the original _execute returns
60PASS/3UNVERIFIED, incomplete UNVERIFIED. Through the external candidate, the
same captured artifacts return60PASS/3FAIL, complete FAIL. This is parser proof,
not a new native run or an upgrade of the actual historical receipt.

Gate: NOT_INTRODUCED relative to actual upstreamf8c825. Its actual Git module
replayed the same capture and returned the identical60PASS/3UNVERIFIED. Original
1c47's classifier is also identical and rejects the same two-attempt capture,
but its Playwright policy is retries0; it did not authorize this retry shape.
The combined policy/consumer incompatibility enters this ancestry at
58bdc6fa: parent9f6ab77 has retry1 but no native semantic classifier; parentb3bf2a73
has the classifier with retry0. The retry policy originates at455c3335; the
single-attempt consumer originates at836c6879. Original1c47 is a separate
branch; no linear bisect or original-native retry execution is claimed.

Problem class: producer and metadata consumer disagree on the permitted attempt
sequence. The deeper owned boundary is the adapter's lack of a strict,
retry-aware interpretation and required recovered-failure metadata, not the
unchanged sidebar assertions, their timeouts, or the retry policy.

Archive searches: `UNVERIFIED classify_lane retry complete` and
`native Playwright retry flaky lifecycle evidence`. Related lifecycle and
semantic-contract incidents were read; this exact retry consumer defect is a
new incident in that family, not a proven recurrence of those prior causes.
The agent's report_bug lookup is inapplicable to this parser/fixture replay.

## Solution

External proposal only; not integrated, deployed, or natively rerun. Accept only
the declared zero-or-one retry policy, contiguous indices0,1, complete matching
per-attempt hook/body lifecycle, exact inventory/project/file/title identity,
and matching native statuses. Reject missing or duplicate attempts/hooks,
third attempts, retry after success, skips, interruption and contradictory
exit/run-end evidence. Both failed/timedOut attempts remain FAIL. Recovery to
passed is FLAKY with the first failure and report location retained; emit the
standard metadata so deploy_test_cycle.open_flaky requires attribution before
merge. Failure to retain required FLAKY metadata remains UNVERIFIED.

Step6a: deleting retry interpretation cannot reconcile the unchanged producer's
permitted attempts, and disabling/reducing its retry policy would change the
acceptance contract. Reuse one bounded per-attempt validation loop instead of
adding a second execution path. Independent review found that an initial legacy
fallback guessed zero retries when report.config was absent, allowing truncated
required retries and bypassing project/file/title checks. The amendment deletes
that fallback: every case requires valid full native config, unique typed project
identity and declared zero-or-one policy. Missing config or identity remains
UNVERIFIED, including a zero-retry pass. Actual browserless-producer omission and
foreign-identity regressions and immutable-capture probes verify this boundary.

Proposed additions to the existing deploy-test-semantic owning suite exercise
the real browserless Playwright producer and semantic reporter, adverse captured
shapes, whole worker dispatch, exit guards and existing FLAKY attribution. All
11 original test method bodies, assertions and timeouts are byte-preserved; only
the old fixture method now supplies actual zero-retry native config and file/title/
project metadata. The amended21-test proposal is red on current code and on the
original proposal, then green on the amended external candidate; exact logs/commands are in the bounded
worker packet. This does not claim complete native semantic acceptance.

At10k cases, the candidate indexes reports and events by ID once and inspects
at most two attempts per case: linear metadata work, no providers, databases,
new polling, or resource allocation. Golden reference: not applicable
(ordinary metadata parser and test changes).


### Actual applied-source validation

The parent integrated the tightened, independently reviewed candidate at a
verified quiescent checkout boundary. The unchanged original11 test bodies,
assertions and timeouts remain byte-identical; only their old incomplete fixture
was filled with the real native zero-retry policy and identity. The actual
checkout owning suite passes21tests in5.789s. The same exact captured-artifact
replay through that applied module returns60PASS/3FAIL, completeFAIL, with
cleanup_complete=true and native_exit1. Missing config, omitted required retry
and foreign zero-attempt identity controls refuse as UNVERIFIED. Actual native38
receipt SHA12bf69a5 remains unchanged and incomplete; the replay grants no native
credit. Parent owns fresh full native semantic verification on the next frozen
source, so this case remains OPEN for that final native confirmation. Private
proofs: repair38-next/actual-semantic-owning.log and actual-applied-semantic-replay.json.

## Human feedback

The user requested completion of /deploy and supplied the standing instruction
to preserve Freedom. No incident-specific human correction was recorded.
The external-only preparation, unchanged assertions/timeouts/retry policy,
immutable native history and quiescent integration constraints in this packet
were instructions from the deployment coordinator, not additional human feedback.

## Reusable lesson

Interpret every permitted native retry as a complete identity-bound attempt and preserve recovered failures as FLAKY metadata requiring attribution.
