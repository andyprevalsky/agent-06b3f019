---
id: 2026-10-07-image-publisher-status-bypassed-registry-handoff
date: 2026-10-07
title: Image publisher success bypassed actual registry manifest availability
surface: infra
component: cloudbench-image-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_image_publish mapped publisher exit zero to publication_verified without checking the actual registry consumer handoff
symptoms:
  - MANIFEST_UNKNOWN
  - registry.fly.io exact tag and digest return HTTP 404 after publisher exit zero
  - image-activate rejects a stopped donor update while native image metadata lookup succeeds
  - Exact manifest republication HTTP 400 with MANIFEST_BLOB_UNKNOWN aborts the existing publication settle budget
tags:
  - cloudbench
  - image-build
  - image-activation
  - registry-handoff
  - manifest-republication
sources:
  - commit 443f33db31efe6f0e97120d186a79487110bdd29
  - agent /root/registry_exact_image_handoff_rca
  - agent /root/publisher_quick_contract_review
  - agent /root/live50_stage_timing_observer
  - commit 749019f97f3c83051d0a9c92e30462f880b4d098
  - commit 895a0704b3092ac77ae386870fa8ced947815b45
  - agent /root/depot_compression_owned_rca
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_exit_zero_cannot_publish_an_unavailable_actual_manifest
status: open
---

## Problem

The unchanged Control4 normal Depot no-cache build exited zero in 411 seconds.
Its private exporter log reported the exact manifest and config export, completed
layer publication, and completed manifest publication. The receipt marked
publication verified while explicitly recording no published-tag resolution.
Two normal exact-image activation invocations then failed at the stopped donor
update with registry `MANIFEST_UNKNOWN` HTTP 404. Neither allocated a benchmark
fleet. The stopped donor retained its previous working Control3 digest.

The originally rejected manifest digest is
`sha256:52334631a382bb97097a119475dff338a4332ad52fd4fba6b7a154196cb28adf`.
Original build/activation receipts remain under the private Control4 output;
this interrupted diagnostic earns zero campaign credit.

## Diagnosis

The path is selected clean checkout and pinned publisher → Depot export/push →
publication receipt → receipt image reference → native donor image update →
registry manifest fetch. The receipt first represented an unverified consumer
handoff as successful. Its success predicate trusted the publisher's exit code;
the native prebuilt resolver separately reads Fly image metadata rather than
proving the registry data-plane object remains readable.

Authenticated concurrent registry GETs returned 404 for both the new tag and
digest, and 200 for both the previous Control3 tag and digest. The previous
working object is also an OCI manifest. The Dockerfile/config hashes, pinned
publisher version, Depot/app scope, amd64 target and zstd settings agree. Both
config blobs are present, Linux amd64, and have identical runtime configuration
and history commands. OCI-only and Docker-only Accept requests still rejected
the new manifest. These observations exclude a generic OCI or runtime-config
explanation. They establish the responses visible to those requests, rather
than a durable loss of the external artifact. Authentication context, refresh,
and later registry visibility require separate controls.

Fly's normal read-only app-image metadata query retained the exact new manifest.
Restoring OCI struct field order and BuildKit's two-space JSON encoding,
including removing only the metadata-added builder annotation when necessary,
reproduced the original 5,251-byte manifest digest exactly. The same process
reproduced Control3's actual registry bytes byte for byte. Recovery therefore
has the exact original artifact, not a newly built or semantically similar one.
Every recovered byte sequence must independently match the digest retained from
the original publisher before any PUT is allowed.

The authorized actual continuation supplied those exact bytes to the owned tag.
Registry PUT rejected them with HTTP 400 and two `MANIFEST_BLOB_UNKNOWN` errors.
Only those two error-identified blob references were inspected: both HEADs
returned 404, neither belongs to the previous working manifest, and their
declared sizes are 536,477,550 and 263,992,518 bytes. The tag remained 404 after
the rejected PUT. These are credential- and time-scoped missing-blob responses;
they do not independently prove permanent storage loss. The original
Fly-integrated Depot build exposes no established saved output handle, so that
manifest-only attempt could not restore the output at that boundary. No layers
were uploaded by the continuation.

A separate normal uncached build on clean repair commit `2fd05622` ran from
epoch 1791381929 through 1791382341 (412 seconds). Its producer again exited
zero, while the repaired handoff returned 74 after exact-tag GET 404 and
hash-bound manifest PUT 400 reporting six missing layer references. A
destination-only diagnostic in a new owned app also failed after 485 seconds,
reporting eleven missing layers and config; its app had no Machines or Volumes
and was deleted. App scope changes both producer/cache namespace and registry
repository, so this is not an isolated registry-repository experiment.

Later, the original 412-second output became readable during the normal pinned
client's `RequireSession` credential refresh flow. Its exact tag and digest
both returned 200 with body SHA matching
`sha256:7e73700c6343f9eddc347f59cdcc3e4b1d77af0ecc6595b85236cd3c1d6e0f0c`;
one previously reported missing blob also returned HEAD 200. Paired reads using
the same refreshed bundle's GraphQL and Docker selections both returned the
same correct manifest. Docker subset normalization is therefore not a proven
causal fix. No credential normalization patch, producer-content hook, layer
upload, or additional build was used for these successful reads.

The unchanged registry helper then repeated the exact normal
`run-bench-cloud` credential resolver and pinned client flow on clean `2fd05622`.
It exited zero from epoch 1791385498 through 1791385499, verified tag and digest,
and did not republish the manifest. Earlier raw-config requests and the normal
refreshed SDK flow are different observations; raw API rejection cannot prove
donor absence or block the normal CLI. The external cause remains open because
refresh and elapsed-time effects have not been isolated.

The fresh normal Control5 run on clean `895a0704b`, whose parent was
`749019f97`, closed after 409 seconds with producer exit zero and CLI exit 74.
The exact tag GET returned 404, metadata POST returned 200, and the original
hash-proven 5,251-byte manifest PUT returned 400 with six
`MANIFEST_BLOB_UNKNOWN` errors. A later read-only diagnostic first observed
the unchanged tag and digest returning matching 200 bodies 180.572 seconds
after the failed CLI exited. Sixteen reads returned 200 and two transport
observations remained unknown. At its final paired observation, both the held
bundle and a subsequently refreshed normal bundle returned 200. The original
failed bundle was not retained, so those reads prove neither credential refresh
nor elapsed time caused the change. No additional build, layer upload or
diagnostic manifest PUT preceded the successful reads.

The recurring owned defect is narrower than the provider visibility cause:
`RegistryHandoff.verify` classified every non-201 manifest PUT as terminal, so
the actual missing-blob 400 bypassed its existing 180-second settle loop.
The earlier inverse test asserted that immediate three-request abort and did
not exercise subsequent readability of the same output. The new localhost
reproduction emits the actual six-error schema,
and makes the exact tag and digest readable at fake-clock second 175. It failed
at the first PUT on unchanged production `749019f97`; the same assertion passes
after the narrow repair below. This proves the premature-abort contract defect,
not the external visibility cause or a fresh cold pipeline outcome.

Archive searches were `MANIFEST_UNKNOWN registry manifest unknown image-activate`
and `image publication successful donor activation digest 404`. No literal
manifest-unknown case existed. The
`2026-10-05-native-image-postpush-metadata-triggered-rebuild` case is a relative:
it addressed a nonzero final-inspection result triggering another full build;
this event falsely passed the ordinary exit-zero publication boundary.

Golden-reference searches of Claude Code, OpenClaw and Hermes for registry
manifest/digest publication found no corresponding container-image handoff
implementation; the local Codex reference was absent. The owning external
references are [BuildKit's manifest encoder](https://github.com/moby/buildkit/blob/master/exporter/containerimage/writer.go),
which hashes its `json.MarshalIndent` bytes, and the
[OCI distribution manifest protocol](https://github.com/opencontainers/distribution-spec/blob/main/spec.md),
which supports exact manifest GET and PUT without uploading its blobs again.
The repair follows those artifact and digest contracts. It does not alter an
agent harness, benchmark task, model, evaluator, provider route or network policy.

## Solution

The existing publisher now verifies the exact registry tag and digest after a
nominal or metadata-recovered publication. Successful receipts hand the next
stage the same image pinned to the actual verified digest. Missing digest headers
do not substitute for or invalidate matching body hashes and tag/digest reads.

When an acknowledged manifest is missing, the continuation obtains metadata
only for the caller's explicit selected app and generated owned tag. It accepts
only bytes matching the independently retained original publication digest,
republishes that exact manifest through the normal Registry V2 endpoint, and
requires the actual tag and digest to return the same bytes afterward. It retains
a generous 180-second publication settle budget with five-second polls;
ordinary healthy handoffs return immediately. It never uploads layers, repeats
the dependency build, falls back to another image, or changes source provenance.

Unverifiable metadata, different digests, authentication rejection, or absent,
malformed, false or foreign handoff receipts fail the stage with exit 74. The
existing build wrapper recognizes that boundary and retains the original build
instead of starting another expensive build. Earlier genuine build failures
retain their existing retry behavior. Private request captures use unique
directories, remain credential-free and private, and do not replace prior
forensic bytes. Authentication follows the selected pinned Fly client; redirects
cannot carry its credentials to another origin.

A 400 containing a nonempty error list consisting only of
`MANIFEST_BLOB_UNKNOWN` entries now enters the existing
settle loop. After one exact PUT, settling is read-only: it reuses the same
credentials and metadata, polls the exact manifest routes, and requires the unchanged
tag and digest bytes before success. Persistent absence still fails within the
unchanged budget; mixed, malformed, unrelated, auth and
wrong-digest responses stay rejected. No compression, builder, task, model,
evaluator, deadline or output is changed.

The new helper is included in the existing immutable controller snapshot. The
healthy path costs two small manifest reads per image publication, independently
of agent count; recovery remains scoped to one owned artifact. At 10,000 agents
this adds no per-agent fan-in, shared mutable state or runtime polling.

## Verification

The permanent actual-shell wrapper reproduction first failed on unchanged
443f33db: publisher exit zero plus an actual localhost `MANIFEST_UNKNOWN` response
returned success. The unchanged command passed after the repair. The owning
image suite also covers exact available tag/digest, hash-preserving republication
and transient publication visibility, metadata-only success with persistent
registry failure, tag-only availability, wrong hashes, auth rejection, missing
original digest, unreconstructable metadata, repeated output directories,
selected-app ownership, rejected missing-blob republication, and
missing/false/malformed/foreign receipt controls.
These `cold_image` tests remain selected automatically by the existing compact
benchmark deployment gate; no new paid or large verification stage was added.

Independent production review cleared the exact helper and three integration
source hashes. The actual unchanged-output attempt ran from epoch 1791381668
through 1791381676, returned 74 on the missing-blob response, and retained its
5251-byte request with SHA matching the original published digest. The original
failed CLI receipts remain failed even when later reads succeed.

Automated review also found a compact response-shape defect: JSON null or a
non-object GraphQL payload could raise an untyped exception instead of retaining
the private handoff failure receipt. Explicit object guards and eight quick
inverse cases preserve exit 74 and the receipt. The owning suite passed 74 tests;
the unchanged malformed-provider command failed before those guards and passed
afterward. This adds no provider or model verification lane.

The missing-blob settle reproduction command is
`python3 -m pytest 'agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_registry_handoff_preserves_exact_manifest_and_consumer_digest[missing-blobs-settle]' -q`.
It failed on unchanged production `749019f97` with
`HandoffError: Exact manifest republication HTTP 400` in 0.65 seconds. The
same command passed after the repair in 0.62 seconds. The final owning image
suite passed all 82 cases in 23.36 seconds, including persistent absence,
nonmatching and mixed 400 errors, empty errors, authentication refusal, wrong
digest, digest absence, acknowledged-201 visibility lag, and an unknown PUT
transport result. Every settle scenario retains at most one original-byte PUT,
one metadata query, actual manifest reads and private captures. Ruff lint and
format checks pass, and archive validation passes. These cases use the existing
`cold_image` selection in `scripts/tests/benchmark-live-results.test.py`.

One unchanged normal `image-activate` of the original 412-second output began
at epoch 1791385658 with `--ref 2fd05622`, after the later normal helper green.
It exited zero at epoch 1791385826 after 168 seconds, with normal image update,
guest readiness, source fetch and parking complete. The final normal native SDK
observation confirmed donor `683e47df5094d8` stopped on the exact `7e73700c` digest.
This qualification is retained separately from the independent native builder
diagnostic and the original failed publication clock. Native builder attempts
are not a qualified fast publication profile: all three failed with unexpected
EOF during dependency installation, and the original CLI closed naturally at
epoch 1791385524 after 2,830 seconds. Both automatic activation watchers were
joined and their process absence verified before the selected activation; both
native CLI collectors and their owned callers were also joined after terminal.

This case remains open for the publication visibility cause and a fresh,
uninterrupted ordinary cold pipeline. Later image-only qualification earns no
campaign credit and does not erase the 411-second original or 412-second
repair-trial failures. The latest user-requested campaign remains five consecutive runs of 50 random
DAILY tasks with the unchanged 1,200-second task and 3,600-second whole-run limits;
historical 50-task artifacts remain historical. Private request bodies, logs,
credential material and all original scalar receipts remain outside the archive.

## Human feedback

The user requires unchanged benchmark tasks and actual normal CLI evidence,
generous stage targets rather than aggressive observation deadlines, automatic
same-output continuation instead of manual intervention or another full build,
and compact owning regressions already wired into deploy. The user restricted
the repair to the exact owned image and required private scalar evidence.

## Reusable lesson

Verify the actual immutable registry handoff and recover only hash-proven original
manifest bytes before handing a successful publisher result to its consumer.
Join each observation to its normal credential selection, refresh, exact image
digest and original clock before interpreting a 404 as lost data or naming an
authentication change as the cause.
