---
id: 2026-10-16-bootstrap-fixture-sealed-mutable-controller-checkout
date: 2026-10-16
title: Bootstrap fixture sealed the mutable controller checkout instead of its private snapshot
surface: harness
component: cloudbench-bootstrap-recovery-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: configure_bound_source passed the concurrently changing checkout scripts tree to the strict snapshot manifest builder
symptoms:
  - controller snapshot changed while hashing
  - FileNotFoundError for an enumerated CPython atomic bytecode temporary file
tags:
  - fixture-isolation
  - controller-snapshot
  - provenance
  - concurrency
sources:
  - PR #1518 fresh deployment qualification
  - commit 11dd68fc7387738f4c69e516708b37bf30cfb3b3
  - commit 2efdbd344c1d5e6df0cd14314ba389e1aa3c55a7
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py
status: fixed
---

## Problem

The full deployment structural gate failed while its quiesced recovery fixture
enumerated a CPython bytecode temporary file in the shared checkout. Another
process removed that file before hashing. The strict production manifest builder
correctly rejected the changing source; fixture setup had selected the wrong
source boundary.

## Diagnosis

Critical path: fixture configure_bound_source → checkout scripts enumeration →
concurrent CPython cache rename → manifest read → provenance rejection. The
normal production controller already disables bytecode writes and seals a private
owned copy. Its source and provenance helpers needed no change.

Archive searches used `snapshot changed while hashing __pycache__ controller`
and `fixture mutable checkout immutable controller snapshot source binding`.
The sealed-snapshot inverse permission and inherited script-snapshot ownership
cases are relatives: they concern generated-copy permissions and process-local
cleanup ownership, respectively. Neither establishes this mutable-source cause.

The new registered regression removes the precise enumerated CPython temporary
file during fixture setup. With the original configure method it fails an
assertion after the actual FileNotFoundError/provenance rejection; two source
tamper controls still pass. The identical three tests pass after the fixture
uses the normal private-copy producer. These are method-scoped causal receipts,
not a claim that an entire old revision was rebuilt.

## Solution

The fixture now invokes the actual normal controller's existing local help/test
hook to obtain its complete private snapshot and exact owner. It seals that copy,
requires equality with the producer's manifest, then releases only its recorded
controller and joins cleanup. Inherited snapshot ownership variables are cleared
for this new owner. Production provenance, snapshot producer and manifest policy
are byte-identical to the baseline; no cache exclusion or read-error bypass was
introduced.

All 28 original test functions retain their ASTs. Three additive registered
controls cover checkout cache churn, changed private source, added bytecode,
unknown source and a disappearing real dependency. Every change inside the
private source remains rejected. The final owning suites pass: 31 bootstrap and
15 quiesced recovery tests. Root independently reviewed the patch and retained
causal logs, adopted the exact commit, and ran the same three new controls with
three PASS. Full combined deployment qualification remains a separate gate.

The original adopted proposal's fixture SHA256 was
`642bdb3d5e1d5aef3b8612177f47ec04224a5422cd66b810bfc76d50bedd4976`.
Before/after and complete owning-suite logs are retained in the source owner's
frozen handoff; root's independent output is in
`.context/admission-integration-checks/snapshot-fixture-root-adoption.log` under
the preserved deployment checkout.

Root also cleared all 24 static diagnostics exposed by the touched fixture:
dictionary literals, explicit `check=False` where return codes are asserted,
binding the per-iteration mutation path, combined contexts, and removing a
shebang from a non-executable module. The full unfiltered Ruff 0.17.0 command
changes from 24 findings to zero; no suppression or configuration was added.
All 82 assertion ASTs and all test names are identical across this cleanup.
The final complete suites pass again: 31 bootstrap tests in 54.183 seconds and
15 forensic/quiesced tests in 38.040 seconds. An initial misspelled companion
test filename supplied no test credit; the recorded passing command uses the
actual `cloudbench-forensic-quiesced.test.py` owner. Production bytes remain
unchanged. Root's static logs and assertion-preservation manifest are retained
in `.context/fixture-static-cleanup` in the final development checkout.

At 10k agents this changes no runtime, provider call, per-agent query or polling.
It reuses a bounded deployment-fixture controller copy and its established exact
cleanup owner. No production resource was allocated or changed.

## Human feedback

The user asked to finish deployment and permits skipping optional gates. No
provenance check, timeout, source membership assertion or required gate was
waived for this repair.

## Reusable lesson

Test immutable provenance against the normal producer's owned immutable source;
concurrent checkout artifacts are not an equivalent fixture boundary.
