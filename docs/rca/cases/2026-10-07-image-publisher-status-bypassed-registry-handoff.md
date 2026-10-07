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

The missing original manifest digest is
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
explanation; they do not establish why the external registry lost an
acknowledged manifest.

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
the rejected PUT. This proves that the current output is missing referenced
layers as well as its manifest. The external reason for that loss remains
unproved. The original Fly-integrated Depot build exposes no established saved
output handle, so manifest-only republication cannot recover this particular
output. No layers were uploaded and no new build or activation was started.

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
5251-byte request with SHA matching the original published digest. The normal
native activation was not started because the registry handoff is still absent.
This case remains open for a complete actual publication/activation green;
the original failed output and zero-credit diagnostic are preserved.

## Human feedback

The user requires unchanged benchmark tasks and actual normal CLI evidence,
generous stage targets rather than aggressive observation deadlines, automatic
same-output continuation instead of manual intervention or another full build,
and compact owning regressions already wired into deploy. The user restricted
the repair to the exact owned image and required private scalar evidence.

## Reusable lesson

Verify the actual immutable registry handoff and recover only hash-proven original
manifest bytes before handing a successful publisher result to its consumer.
