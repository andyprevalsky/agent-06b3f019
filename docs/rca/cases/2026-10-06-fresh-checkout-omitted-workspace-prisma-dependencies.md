---
id: 2026-10-06-fresh-checkout-omitted-workspace-prisma-dependencies
date: 2026-10-06
title: Fresh guest dependency sync omitted workspace-local Prisma assets
surface: infra
component: cloudbench-dependency-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-sync-deps mirrored only root node_modules while the baked image carried a workspace-local generated Prisma client
symptoms:
  - both mandatory canary guests completed checkout and dependency refresh before failing Prisma generation
  - npx no-install considered Prisma missing and canceled a floating Prisma 7.10.0 request
  - no report card or task execution was produced
tags:
  - cloudbench
  - fresh-volume
  - npm-workspaces
  - prisma
  - dependency-sync
sources:
  - commit 02ca135bef520ba07bbd7c8612bbc880570cb7de
  - fleet run 20261006-091850-42119
  - plan:.context/fresh-volume-provisioning-20261006/prisma-bootstrap-rca/actual-failure.safe.json
  - plan:.context/fresh-volume-provisioning-20261006/prisma-bootstrap-rca/permanent-original-red.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_prebuilt_prisma_client_sync_preserves_donor_workspace_layout
status: open
---

## Problem

The first mandatory canary on the fresh-volume implementation failed before any
benchmark execution. Both retained guest drivers completed exact source checkout,
refreshed JavaScript and Python dependencies, and then failed client generation.
The underlying npm error was a missing installed Prisma executable followed by
cancellation of its Prisma 7.10.0 request. The no-install flag prevented that
floating package from replacing the intended installed version. Neither guest
log contains an ownership, network or schema-compatibility error.

Payment checkout completed at 09:25:24 UTC, dependency sync started at 09:25:25,
and the fatal driver result was recorded at 09:26:57. Browser checkout completed
at 09:28:53 UTC, dependency sync started at 09:28:54, and its fatal result followed
at 09:31:10. Both refreshed 57 Python venv paths. Checkout latency and the failed
Prisma boundary are separate evidence. This attempt has zero acceptance credit;
normal exact-owner cleanup belongs to the campaign supervisor.

## Diagnosis

Path: exact checkout → matching donor manifests → root-only dependency mirror →
missing workspace-local Prisma assets → root-cwd npx discovery → generation
failure → driver exit before stack readiness or task evaluation.

The exact ff89 image's retained build log generated Prisma 5.22.0 to
`./node_modules/@prisma/client` after the unchanged installer entered `back-end`.
The schema was backend-relative. This establishes a backend-local generated
client in that build. The image's dependency installation succeeds, but the guest
helper copied only root `node_modules` and created marker-only workspace folders.
Its assumption that all required workspace assets were hoisted was false. Direct
guest asset inspection was unavailable after normal resource retirement; the
build destination proves the generated-client layout, rather than a complete
native package inventory. The current
ignored root lock also contains backend-local Prisma entries; its unknown
historical build hash is not used to establish image equivalence.

Archive searches were `Prisma missing npx no install` and
`copied image node_modules workspace dependencies fresh checkout`. The July 24
floating-Prisma executable-discovery case is a recurrence at the resolver
boundary; the July 15 warm-image fingerprint mismatch is related. Here the
manifest check passed and the needed assets existed in the image, so rebuilding
dependencies is not established as the repair.

The old cached image has different manifest inputs and a hoisted Prisma layout;
it is excluded as proof of ff89 contents. A faithful offline reduction executed
the actual two helpers with real pinned Node/npm: the hoisted donor passed, while
the workspace-local donor's copy succeeded and Prisma failed. The same final
permanent layout controls on unchanged source produced one failure and one
passing hoisted inverse in 2.73 seconds.

## Solution

Mirror existing backend, frontend and agents dependency trees from the matching
donor alongside the root tree. Each workspace tree carries the same dependency
fingerprint. A matching older root-only receipt can repair a missing workspace
tree; an incompatible donor cannot replace a valid cached or rebuilt dependency
set.

Resolve the installed Prisma package through Node from the backend, allowing its
normal workspace-local or root placement. Execute that package's declared CLI
with Node, and require both package and executable to remain inside the checkout.
There is no npm install or registry fallback. Existing fatal-generation behavior
remains unchanged. Refreshing Node assets invalidates their schema marker: the
copied client can belong to the donor's older schema despite matching dependency
manifests. Independent review reproduced a legitimate current marker surviving
workspace replacement and incorrectly suppressing generation. The same layout
owner now retains that marker, restores an older donor client and verifies that
actual Node generation produces the current schema. The hoisted cached inverse
continues to reuse its already-current output.

The primary also gives its copied dependency trees to the application user before
generation, matching the worker's existing order. This is a separate ownership
contract, not the original guest error. A bounded network-none Linux control ran
the actual old/new primary dependency stage with a root-owned generated-output
directory and the real `rose` user: old source failed with EACCES, new source
wrote the client. The control completed in 1.879 seconds and its exact container
was absent. A preliminary private fixture used an inaccessible parent directory;
that setup failure is retained and excluded from acceptance.

Existing regeneration and fatal-marker controls plus the two donor layouts and
outside-checkout inverse passed. The focused six-case candidate selection passed
in 3.28 seconds on the final strengthened source. All three new cases are selected by the existing normal compact
`prebuilt` registration. The existing Prisma blackbox's unchanged selector now
expects five cases rather than two. Live canary and the requested fifty-copy
campaign remain pending; this case stays open until that owning runtime boundary
is exercised normally.

The image recipe, install helper, manifests, schema and requirements are unchanged.
The two modified dependency helpers are source-layer files and are delivered by
the existing controller-owned boot payload and legacy staging transport. Old
thirteen-input equality is therefore qualified as eleven unchanged image inputs
plus two current staged helpers, rather than full source equality. No model,
prompt, task, evaluator, canonical seed, result, ownership policy or task budget
changed.

At 10,000 agents this adds no provider operation or shared global lock. Required
workspace assets are materialized once per missing or stale dependency tree;
matching fingerprints skip repeat copies. The required copy costs local disk I/O
and prevents an invalid readiness path. These controls do not establish a model
quality improvement, repair the provider snapshot engine, or award any benchmark
acceptance credit.

## Human feedback

The user requested compact permanent regressions and faster ordinary CLI stages,
while preserving real execution, resource cleanup and the inherited network route.

## Reusable lesson

A dependency fingerprint does not prove that every installed workspace tree was
materialized. Preserve the installed package layout and resolve its executable
from the consumer's real dependency graph before declaring bootstrap ready.
