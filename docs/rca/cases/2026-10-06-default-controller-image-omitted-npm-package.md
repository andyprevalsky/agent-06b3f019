---
id: 2026-10-06-default-controller-image-omitted-npm-package
date: 2026-10-06
title: Default offline controller image copied Node without its npm package
surface: infra
component: cloudbench-controller-tests
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the default controller image copied the pinned Node executable but omitted its npm package and executable links, while image admission omitted both package runners
symptoms:
  - default controller image passed its tool preflight
  - both first-scenario controllers reported npx not found before seed verification or fake clone allocation
  - ordinary native controller suite exited 1 after 22.309 seconds
tags:
  - cloudbench
  - offline-controller
  - docker
  - npx
  - preflight
sources:
  - commit 62833f1f02f1ebd81521daf5e290513068b546cf
  - plan:.context/deploy-permission-owner-20261006/default-fixture-failure.safe.json
  - plan:.context/controller-default-npm-rca-20261006/review-handoff.safe.json
repro: scripts/tests/cloudbench-controller-linux.test.py::ContainerOwnership::test_tool_preflight_rejects_missing_or_broken_package_runners
status: fixed
---

## Problem

The ordinary default offline controller route selected its recipe-labeled image
`f948350b`. Its preflight accepted Linux/Python, Node, Bash and the existing shell
tools. Both scenario1 controllers then stopped at the real guest seed-dump
preflight because `npx` was absent. No fake clone allocated. The original normal
suite exit1, its partial export and the dispatcher's rejection of complete export
proof remain retained; they receive no passing credit. The actual supported
review image is a separately qualified route for the current deploy gate.

## Diagnosis

Critical path: default pinned-stage image recipe → cached recipe label → actual
image capability preflight → normal shell fixture → seed-dump guard → controller
admission. The recipe copied `/usr/local/bin/node` from Node22.13.0 but omitted
that stage's npm package and its npm/npx links. The earlier capability preflight
checked neither runner, so it accepted an image unable to start an existing
mandatory controller operation. The runtime guard correctly rejected it.

Archive searches used `controller image npx command not found` and
`copied node binary npm package missing offline preflight`. The floating-Prisma
CLI case is a relative about executable discovery, and the frontend compiler
readiness case is a relative about checking the actual consumer. Neither has
this missing-package boundary. This is a new offline fixture-image case.

## Solution

Copy the npm package from the same pinned Node stage and add explicit
npm/npx links after the existing apt layer. The previous layers and package
versions remain intact. Extend the actual image capability preflight to require
both executables, run each local `--version`, and reject unusable or mismatched
package runners before the native suite begins. No package install is performed
by this runtime preflight.

The permanent compact control executes the actual preflight with isolated
executable tools. The healthy case succeeds; missing npm, missing npx, failed
npm/npx version commands, invalid version output and distinct runner versions
are rejected. On the original dispatcher the unchanged owner fails all six
negative subcases, while the nine earlier ownership/cleanup controls remain
passing. The same complete owner passes on the candidate. The pinned
Linux/Python values in this synthetic admission fixture are explicit fixture
inputs; the separate real image proof checks the actual platform and versions.

The ordinary default candidate build and `--check-only` passed in 2.277 seconds
with matching recipe label, using cached existing build layers. A network-none
fixture executes the unchanged real seed-runner guard and function with the
existing normal suite's local seed and TSX stubs. The same body fails on the
original default image at absent npx in 0.344 seconds, then succeeds on the
candidate in 0.476 seconds with a 32-byte local seed file, Node22.13.0 and
npm/npx10.9.2. Both exact named/labeled/CID containers were verified and removed.
This proves the missing-tools boundary. It does not replace the complete normal
controller suite, model task outcomes, provider acceptance or the requested fifty
executions. No such workload was launched by this RCA.

One earlier native proof supervisor failed its own case-sensitive absence-message
assertion after it had removed its exact original-image container. That attempt
is retained and excluded from passing custody proof; subsequent exact inspection
confirmed it absent. The replacement identical native body has complete
retirement receipts for both variants.

Independent review repeated the same frozen owner on both sources: the original
failed all six negative subcases in 2.134 seconds; the candidate passed all ten
controls in 3.183 seconds. Both actual image identities, recipe labels, unchanged
seed-runner body and exact container retirement were independently verified.
The reviewed three-file fixture repair is now applied to the coordinated source
checkpoint; the full normal native suite also qualifies its actual default image
before merge. The existing owner is already on the normal
`/deploy` controller route; the new control adds no separate broad suite. At
10,000 agents this affects one offline test-image preparation and two local
version commands per dispatcher admission, with no model/provider hot-path work.
No task, evaluator, result, dependency lock, production runtime or timeout changes.

## Human feedback

The user requires stable ordinary CLI routes and compact permanent regression
coverage, while independent agents optimize the largest fleet-readiness delays.
The current paid fifty-copy campaign must proceed independently on its current
image; this offline fixture repair must not delay or restart it.

## Reusable lesson

A copied language executable does not establish the package-runner capabilities
needed by the actual consumer. Package the pinned toolchain and test those local
commands at image admission before allocating the workload.

### 2026-10-07 recurrence: extracted cache-parent owner imported pytest

Synchronizing deployment source with `a07d44ab5` exposed a new framework
dependency at the extraction boundary. The ordinary
`python3 scripts/tests/run-cloudbench-controller-linux.py --fixture status-service-shutdown`
failed with `ModuleNotFoundError: No module named 'pytest'` before its three
cache-parent permission cases. The recipe-labeled offline image deliberately
has no pytest dependency; the extracted owner only uses that framework's skip
primitive. Its actual permission body and decorator-derived cases need the
standard library. The first bad boundary was importing the full framework to
adapt that one primitive, rather than a missing production dependency.

The existing compact controller owner now executes the actual extracted block
with pytest unavailable and the native permission capability absent. On the
unchanged fixture it failed at the pytest import. The identical test passes
after the extraction boundary supplies a standard-library `SkipTest` adapter.
It requires all three skips to be counted and rejects an all-states PASS claim
when no native case ran. The fixture preserves the actual permission bodies,
their derived cases, all assertions, and ordinary exception propagation.

The full existing compact owner passed 13 tests in 2.872 seconds. The unchanged
ordinary Linux dispatcher command then passed: all three actual root/Linux
cache-parent permission cases ran, with `3 passed, 0 skipped`, followed by the
existing generation-publication and authenticated shutdown controls. The normal
dispatcher verified retirement of both exact owned containers. Original RED,
identical-test GREEN, source/recipe hashes, and native custody are retained in
`.context/registry-checkpoint-deploy.private/controller-cache-skip-boundary-proof.safe.json`
in `rose-registry-handoff-deploy-2fd-20261007`.

The same registered controller owner remains in ordinary `/deploy` structural
and controller gates. This is one fixture-local adapter and bounded case
accounting; the offline recipe, production runtime, model/provider path, budgets,
and the running LIVE50 source are unchanged. The earlier missing-package RED and
this framework-import RED remain separate evidence, with zero benchmark credit.

Independent parent review verified the complete repair, original RED/GREEN and
native custody hashes, unchanged recipe, and both exact containers' absence.
The same 13 permanent owner checks passed independently in 3.269 seconds. Its
`root-controller-cache-skip-independent-review.safe.json` receipt in the parent
checkpoint directory has SHA-256
`c132b6cf2f0211ae2bc724aff101d579bbdcea07880af15820ad70caf68e7371`.
