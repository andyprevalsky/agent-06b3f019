---
id: 2026-09-30-cloudbench-fake-private-address-prefix-collision
date: 2026-09-30
title: Fake cloud guests shared a truncated private address and scenario 3 reached the wrong driver
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The fake clone reduced a 14-hex-digit machine identity to a four-digit private-address prefix
symptoms:
  - "stopped inventory must not consume shared-compute capacity in the isolated CPU replay"
  - "driver exited without cleanup acknowledgement"
  - "guest shutdown without sealed runtime evidence"
tags:
  - cloudbench
  - fake-provider
  - machine-identity
  - private-ip
  - synchronized-barrier
sources:
  - PR #1299
  - commit 9d44d054cae4ed89eea11c6a469697a881583683
repro: scripts/tests/cloudbench-fake-volume-contract.test.py
status: open
---

## Problem

The unchanged mandatory Linux multi-workstream suite failed after 876.105
seconds in scenario 3. That case reproduces the 54-machine inventory shape,
including 31 stopped machines, and requires seven active primaries to finish
without treating stopped inventory as active CPU consumption. The original
failed aggregate, fixture, logs and exact source are retained privately.

## Diagnosis

Admission, clone, configuration and startup succeeded for all seven new fake
guests. Two distinct machine identities nevertheless shared the same first
four hexadecimal digits. The fake clone generated each private address from
only those four digits, and the fake proxy selected the first machine with
that address. Requests intended for the later guest therefore reached the
earlier guest instead.

The later guest's actual driver log contained readiness and a barrier timeout,
but its log-generation marker was absent. The controller observed only six of
seven ready drivers. The other drivers then reached the original 120-second
fixture barrier deadline; subsequent teardown reported missing cleanup
acknowledgements and sealed runtime evidence. Those errors are downstream of
the wrong guest identity. The real capacity guard did not reject this inventory.

Archive searches for the capacity symptom and for fake-provider UUID/private-IP
collisions found related capacity and receiver-identity cases, but no earlier
case establishing this truncated-address defect. The original fixture retained
its native claims and ledgers. Original owned processes were verified absent
before the focused replay. These are local fake-provider allocations; there
were no real cloud allocations or model calls.

## Solution

The fake clone now retains all 56 bits of its existing machine identity in a
valid IPv6 address. A separate fixed namespace marker keeps those addresses
distinct from the fixture's legacy inventory. No production controller,
capacity rule, timeout or scenario assertion changes.

The existing fake-volume contract invokes the actual embedded clone
implementation with two controlled UUIDs sharing the historical four-digit
prefix. It checks distinct machine identities, valid and distinct IPv6
addresses, and that each address selects exactly its intended machine. All
existing volume and preflight assertions remain. The same final test failed
against the original provider in 1.267 seconds and passed against the repaired
provider in 1.634 seconds. The final test SHA was identical in both runs.

A focused native replay extracts the existing scenario 3 assertion block
unchanged, preserves its 120-second barrier and 240-second case bounds, and
forces the observed shared-prefix condition. The repaired-provider replay passed
in 47.972 seconds, with all seven guests completing the original scenario's
capacity, execution and teardown assertions. Its exact wrapper and case
sessions, and remaining new fixture processes, were verified absent afterward;
the normal fixture cleanup also removed its temporary directory. The original
Linux failure and the fast actual-clone red/green pair are the causal red
evidence. A redundant slow red replay was already running
when the operator requested that it be avoided; it was cancelled through its
exact owners, its sessions and remaining fixture processes were verified gone,
and it is not counted as a completed red result. Its prepared recipe and
cancelled evidence remain private.

The required complete Linux controller suite must still pass on the final
committed source before this case closes. The original failure is not relabeled
and none of this diagnostic work grants paid-fleet acceptance credit.

Private receipts, unchanged assertion-block hashes, original source and fixture
archives, logs, final fast red/green evidence and native replay owners are under
`.context/acceptance/proof85-native-scenario3-rca/`, with the original runtime
evidence also retained on the owned controller.

## October 1: a format-specific consumer rejected the repaired provider address

The final-source native suite on `0bf943c9` passed its earlier cases, then failed
scenario 2a after 138.046 seconds: "the status tunnel must target the indexed
private IP". The case's actual controller returned zero, and the retained
provider journal contained successful status and metrics proxy requests to the
same valid full-identity IPv6 address. Two post-run grep assertions still
required the old `fdaa::` spelling. This was a stale fixture consumer, not a
production tunnel or DNS failure. The earlier fast owning case proved address
validity and identity separation, but did not execute this consumer.

The clone fixture now retains its actual provider index row before normal
teardown removes that row from the live inventory. Scenario 2a resolves its
intended primary through the actual warm-parent clone journal and returned name
marker, then checks both proxy targets against that exact captured row. It
requires valid IPv6, unique indexed identity and both status and metrics
tunnels. The original DNS-failure injection, controller exit assertion,
explicit start requests and metrics-after-successful-start ordering remain.
Neither production behavior nor any deadline changes.

The existing fast contract executes the scenario's actual assertion block
against addresses emitted by the real fake clone. The same final test failed
on the original status grep in 0.992 seconds and passed the repaired assertion
in 1.734 seconds. It also rejects a hostname, an unknown valid IPv6 address,
another indexed machine's address even with a start in the control journal,
and ambiguous provider rows.
All prior volume/preflight and full-identity collision controls remain. The
original native result, retained fixture, exact failing bytes, final test/source
hashes and red/green receipts are private under
`.context/acceptance/proof85-native-multi-final-rca/`.

Archive searches used the exact indexed-private-IP failure and fake IPv6
fixture/identity vocabulary. This is a follow-up to the same fixture repair:
the missing guardrail was exercising its actual address consumer. The complete
mandatory Linux suite must still pass on the committed repair. Earlier passing
commands retain their original source identity only where their executed
inputs are unchanged; they are not relabeled as new executions. This work
grants no paid-fleet acceptance credit.

## Human feedback

Use the actual failure and the compact permanent owning reproduction. Avoid
repeating a slow failing scenario once its cause is proven. Preserve the
original assertions and bounds, run the repaired existing case once, and keep
the mandatory final native gate.

## Reusable lesson

A fake provider must preserve the same identity separation as the real
provider. A short UUID prefix can make a lifecycle test contact another guest;
that error can surface much later as a capacity, barrier or cleanup failure.
Consumers should assert the actual provider identity, rather than a particular
textual compression of its valid IPv6 address.
