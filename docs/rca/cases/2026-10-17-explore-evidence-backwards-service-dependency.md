---
id: 2026-10-17-explore-evidence-backwards-service-dependency
date: 2026-10-17
title: Pure explore evidence depended backwards on its calling service and failed structural integration
surface: agents
component: domains/spawn_agent/evidence.py
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service and handler imported a non-layer evidence module that imported the calling service for bounded rendering
symptoms:
  - CIRCULAR IMPORT in first-party modules
  - domains.spawn_agent.evidence to domains.spawn_agent.service to domains.spawn_agent.evidence
  - spawn_agent/service imports own layer evidence
  - spawn_agent/handler imports own layer evidence
tags:
  - explore-evidence
  - dependency-cycle
  - layer-ownership
  - structural-integration
sources:
  - commit e7fdc991fab067d1b1f0349c6c14f71d2bf8aafb
  - plan: .context/auth-deploy/e7-evidence-layer-rca/proof.json
repro: Same canonical bash scripts/tests/agents-structural.test.sh on private physical e7 source before and after the import-owner correction
status: open
---

## Problem

The actual e7 G3 `agents-structural` command failed `no_circular_imports` and
`import_directions`. Its log reports
`domains.spawn_agent.evidence -> domains.spawn_agent.service -> domains.spawn_agent.evidence`
and two forbidden own-layer imports from service/handler to evidence. The full
agents coverage command separately passed111blackbox domains,184cache tests,
134unit tests and83%coverage. That behavioral result did not establish the
independent architecture contract. The structural gate ran and correctly rejected
the source; this was not a skipped gate or a native task verdict.

The candidate and this case remain private pending parent integration review.
Current e7 native outcome is still pending/root-owned; this failure supplies no
signup, account-choice, handoff, model or provider diagnosis.

## Diagnosis

The critical path is typed native grep result -> evidence admission utility ->
service heartbeat/result -> parent handler rendering. The new pure evidence file
was placed beside domain layers, but service permits only own config/repo/types
and handler permits own config/service/types. Both imported own.evidence, outside
that existing contract. Its legacy fallback then imported the service's
`_bounded_explore_parts`, creating the backwards edge to its own caller. These are
runtime-value imports even though lazy placement can avoid an immediate import-time
exception; the checker is not falsely treating erased TypeScript types as values.

The component's producer/builder tests could pass while the complete static module
graph was invalid. The first full structural integration exposed that distinct
boundary. No unobserved explanation for an earlier workflow or CI omission is
asserted. Broadening the import allowlist, hiding the edge behind dynamic imports,
or ignoring strings would preserve the ownership problem.

Two canonical archive searches were executed: `circular import own layer service
evidence utils` and `shared pure helper dependency cycle structural import
directions`. Solution and Human feedback were read for
`2026-10-01-agents-structural-suites-never-ran-in-deploy`,
`2026-09-27-browser-module-import-block-split-by-helper` and
`2026-07-27-type-only-import-flagged-as-runtime-circular-import`.
The first concerns omitted gate registration, the second import ordering, and the
third a TypeScript type-only false positive. Their first boundaries differ, so
this is a new case rather than a fabricated recurrence. The earlier single-home
pure utils ownership pattern is applicable; their diagnoses are not imported.
RCA methodology/process-feedback rules retain owning RED/GREEN and separate native
outcome proof.

## Solution

The private candidate gives the pure logic one lower owner:
`utils/explore_evidence.py`. It moves the existing typed evidence functions and
the exact existing bounded renderer there, removes the old domain.evidence file,
and retargets callers. The service imports `_bounded_explore_parts` as its existing
publicly reachable alias so legacy consumers remain compatible. Handler imports
its renderer at module scope, consistent with the existing Temporal sandbox rule.
Registered tests change only their helper import paths. The utils module imports
only standard-library dependencies, with no domain/provider back-edge.

All evidence function ASTs are identical apart from removal of the backwards
service import; the clipping function AST is identical. All456e7test assertion ASTs
remain identical, including436original and20new assertions. Native ownership,
source digests, whole records, explicit omissions, last-three deduplication,
6000-character budget, legacy fallback and existing50k compaction behavior are
unchanged. No prompt, schema, model, task, evaluator, timeout, cap, classifier,
recovery/terminal rule, structural policy or assertion is weakened.

The reproduction uses a physical1059-file source tree read from immutable e7 Git
blobs, with no native history or donor-source symlinks. Its read-only prepared venv
supplies third-party dependencies; private source is the only first-party import
root. A socket-denial guard is installed before imports in every Python child.
The SAME normal owning command runs before and after:

```sh
bash .context/auth-deploy/e7-evidence-layer-rca/run_structural.sh
# wrapper invokes unchanged bash scripts/tests/agents-structural.test.sh
```

Before: exit1 with the same cycle and two import-direction violations.
After: exit0 for every normal structural suite, with no test/policy changes.
Then the unchanged canonical registered `scripts/run_blackbox_tests.py spawn-agent`
entrypoint passes1domain/0failed,141printed checks,3.6s. Nine guarded process
receipts record0network attempts and0transmissions. There were no model, API, DB,
provider, native benchmark, install or live cleanup calls.

Candidate patch SHA256
cf279e9605d5d2006a88659ca2c0e5ac7c8bc9f70580e895188d11de540bad41.
Proof SHA256
ed0b1420703dec417e52aa4ace4045afa16a6633f6431d4546f72956c95ccb8a
binds the physical source manifest, source/body/assertion checks and exact logs.
Before structural log SHA256
682bf7081bda2ed8a16a8abafc8f65bc6149aec8b9e1ea122987df0fbb53ff5c;
after structural log SHA256
f16a3c4fe690764f489fc878f45bc8c81c83682800a327515a9e79c15c0fd46d;
after spawn-agent log SHA256
1b5e4a1f1f7577d894f4cd7a3c64ef1253ee956b3dc7fb6f1f23a4de2a7047bd.
A private proof-manifest construction error in source-relative path filtering was
corrected without changing candidate/test bytes; all preceding artifacts remain.

This closes the locally reproduced mechanical boundary only. Module/source
identity changes despite preserved function bodies; no historical model-wire,
source-cache or native parity follows. No full47/fullcoverage/native run on the
candidate is claimed. Parent owns next-source review, integration and fresh gates.
This case stays OPEN until that integration status is recorded.

## Human feedback

Parent required a private source-owner correction while current e7 native and
backend coverage consumers continued on immutable source. Explicit requirements:
no import allowlist or structural assertion weakening, no dynamic-import dodge,
preserve typed evidence behavior, reproduce the same normal owning gate, retain
all456assertions and failed receipts, and keep local component proof distinct from
native outcome. User permits engineering/verification now and requires approval
only at deployment. This record creates no approval request or deployment grant.
Freedom and protected instructions/services remain untouched.

## Reusable lesson

Place shared pure evidence and rendering below their callers, and run the complete
architecture gate after joining a component into the source tree; passing behavior
tests cannot certify import ownership or an acyclic integration graph.

## Outcome (2026-10-19)

The typed explore grep-evidence change this case concerns was dropped before deploy at the user's direction: its motivating cause (2026-10-15 minted-signup) was never proven, and the explorer keeps main's existing grep evidence path.
