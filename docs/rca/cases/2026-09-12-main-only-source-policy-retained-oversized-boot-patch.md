---
id: 2026-09-12-main-only-source-policy-retained-oversized-boot-patch
date: 2026-09-12
title: Main-only source admission prevented published feature commits from replacing an oversized boot patch
surface: infra
component: cloudbench-source-delivery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_fetchable_ref rejected feature-only SHAs even when the current authenticated guest fetcher could retrieve and verify them
symptoms:
  - "machine-config payload is 1053180 encoded bytes, over the 900000-byte ceiling"
  - "largest entry: /cloudbench-boot-payload.json.gz (1003320 encoded bytes)"
tags:
  - cloudbench
  - boot
  - source-delivery
  - authentication
  - workspace-patch
sources:
  - PR #1299
  - fleet run capability-stability-20260912193727-17967
  - fleet run 20260912-123748-19906
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_payload_fetchable_source_uses_authenticated_live_origin
status: open
---

## Problem

Proof17 stopped before benchmark execution. The two-machine canary's boot
configuration contained 1,053,180 base64-encoded file bytes against the unchanged
900,000-byte guard. The complete compressed envelope alone accounted for
1,003,320 bytes. The guard rejected the request before a provider configuration
update; this incident does not establish a provider-side body rejection. The
proof remains failed with zero accepted slices. Parent-owned canonical cleanup
and independent verification subsequently retired its exact resources and Hub.

The requested committed candidate was not published for guest fetch. Its
2,484,543-byte plaintext workspace delta was therefore required to reconstruct
the requested source from the fetchable main ancestor. Simply omitting that
patch would run different code. Investigation additionally proved that ordinary
feature publication could not remove the patch under the existing main-only
selection policy, although the current authenticated guest transport could
fetch the feature commit. The unpublished input and that independently
reproduced policy inconsistency are distinct facts.

## Diagnosis

Saved envelopes for `agent-payment-abandonment` and `browser-event-ticket` each
contain all 16 required entries: 15 current helpers/provenance files and the
630,374-byte gzip workspace patch. Decoding the patch reproduces the expected
plaintext SHA256
`515422142d7ba27a49148c8444ffb3057d0ae5305ed41af240f2c80431f14b8f`.
Repacking with the pinned environment reproduces the envelope byte-for-byte.
Executing the actual size guard with that envelope and the actual three
entrypoint files reproduces exactly 1,053,180 bytes and exit1 locally.

Archive searches for `boot launch payload too large 900000` and
`unpublished commit workspace patch payload fetchable compressed` found
[the earlier incomplete-compression case](2026-09-11-boot-payload-compressed-only-workspace-patch.md).
Its complete-envelope repair is present and working: no bootstrap helpers are
being left uncompressed here. Removing only the patch in a diagnostic copy of
this old envelope reduces the encoded total to 202,124 bytes, but that is a
conditional capacity measurement, not permission to discard source bytes or a
measurement of a later candidate.

The source-policy search led to
[the August19 authentication case](2026-08-19-refresh-deps-empty-github-token-aborts-fleet.md).
It both unified warm refresh onto the authenticated exact-ref helper and
restricted admission to `origin/main` ancestors. The current helper still
requires a controller token for GitHub, installs request-scoped authentication,
fetches the requested SHA, verifies `FETCH_HEAD`, and verifies checkout. The
main-only predicate and its old structural expectation remained after that
transport was unified.

The permanent regression uses a real local Git repository and an auth-required
loopback HTTP server. It first executes the unchanged guest helper to fetch and
verify the feature SHA with a synthetic token, then calls the actual controller
selector. Before the production edit, the three published-source cases failed
while seven fallback controls passed. Thus authenticated delivery succeeded
before source admission selected the main ancestor or rejected patch-disabled
operation. No external repository, provider, credentials, or benchmark was used.

## Solution

Keep the existing main-ancestor fast path. For other locally resolved commits,
admit only a matching branch or tag tip advertised by a bounded authenticated
read of the canonical same repository. Local `origin/*` containment alone is
insufficient: a deleted or moved remote ref can leave stale tracking state.
Unknown, unpublished, denied, unavailable, or stalled discovery retains the
complete main-based patch path; disabling that patch still fails closed when
source delivery cannot be established.

Discovery runs outside the workspace with inherited Git configuration,
repository selectors, and tracing removed. Authentication is scoped to the
canonical repository URL and redirects are disabled. An actual process control
checks that the ten-second discovery bound reaps its exact owned Git
process. Independent review exposed two additional local controls: poisoned URL
rewrites must not redirect the authenticated query, and unrelated Unicode ref
names must not invalidate an otherwise matching SHA. The latter failed against
the first parser and passed after comparing the Git advertisement as bytes.

The same complete patch generator remains responsible for tracked and untracked
edits on top of an admitted commit. Guest exact-SHA verification, provenance,
compression, the 900,000-byte guard, task deadlines, evaluator, and acceptance
criteria are unchanged. A ref disappearing after advertisement fails at the
existing exact guest fetch boundary rather than accepting stale code.

The new cases run through the existing `boot_payload` selection in the
benchmark blackbox gate. They cover published source with and without patch
permission, tracked/untracked edits, unpublished and stale refs, denied/missing
authentication, read failure, wrong repository, main compatibility, a stalled
query, configuration/trace isolation, annotated tags, and Unicode sibling refs.
Private receipts are under
`.context/acceptance/proof17-boot-payload-rca/`.

The final unchanged 14-case fixture reports 7 failures and 7 passing controls
against the frozen baseline helper, then all 14 pass in the repaired owning
suite. The complete boot-payload selection plus three adjacent fetch/auth
contracts reports 29 passing cases in 26.48 seconds. Native environment checks,
Ruff, shell syntax and diff checks also pass. The final baseline replay changes
only the test module's helper path to the byte-exact baseline; no production
file is swapped and the fixture assertions are unchanged.

## Validation limits and next boundary

This repair enables normal source publication; it does not publish a commit.
After the final candidate is committed and published to the same repository,
its exact SHA must be independently observed through the authenticated source
path. Before another paid launch, the actual current boot assembly must pass the
unchanged guard with current canonical provenance and the complete patch
computed against that admitted SHA. The private
`.context/setup/measure-proof-boot-payload.py` performs that local measurement and
rejects a mismatched provenance/patch binding; it makes no network or provider
calls and does not itself prove remote availability.

The committed candidate `e706019a625e0009d9758446f107762f29a7a234` was
published on an exact diagnostic source ref in the same private repository.
Authenticated admission verified the exact SHA with patches disabled. Local
assembly measured 204,176 encoded bytes under the unchanged 900,000-byte guard.
The current controller gate passed, preserving the earlier thirteen-gate core
baseline rather than relabeling those earlier executions as current-head tests.

Proof `capability-stability-20260912201842-35760` then fetched this exact
commit successfully in both canary guests and all ten actual benchmark guests.
All ten benchmarks started and produced real model output and tool activity.
This confirms the repaired source-delivery boundary. The attempt nevertheless
failed infrastructure acceptance: three autoscalers exhausted their metrics
polls during collection after guest shutdown. Its failed verdict and zero
accepted slices remain unchanged. Exact cleanup of all twelve machines and
volumes was independently verified, all ten durable evidence bundles published,
and its exact Hub retired. The separate cleanup recovery did not rewrite the
historical failed lifecycle or summary. Receipts are under
`.context/acceptance/proof18-cleanup-independent/`,
`.context/acceptance/proof18-evidence-recovery/`, and
`.context/acceptance/proof18-hub-retirement.json`.

The ten consecutive ten-task infrastructure proof remains pending.
Ordinary task PASSED and FAILED outcomes count only when the
required startup, progress, evaluation, teardown and durable evidence contracts
pass. This case makes no benchmark-quality or all-business-pass claim.

## Human feedback

The user explicitly required infrastructure-only acceptance, unchanged benchmark
and harness criteria, and a five-minute cap for proof tasks. Ordinary task
failures count when startup, progress, evaluation, teardown and evidence are
correct. The source-delivery repair changes none of those criteria, prompts,
models, evaluators or task deadlines.

## Reusable lesson

Admit exact source commits from current authenticated remote evidence, preserve
every remaining patch byte, and keep transport size checks fail closed.
