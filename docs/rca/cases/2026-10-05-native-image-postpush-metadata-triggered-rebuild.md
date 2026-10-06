---
id: 2026-10-05-native-image-postpush-metadata-triggered-rebuild
date: 2026-10-05
title: Completed native image publication was rebuilt after final builder metadata refusal
surface: infra
component: cloudbench-image-build
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_warm_image treated a post-publication Fly ImageInspect failure as a failed image build and retried the full cold build
symptoms:
  - native push completed but the producer CLI exited unsuccessfully
  - count not find built image followed a builder authorization refusal
  - a second full cold build started despite an authenticated consumer resolving the exact published tag
tags:
  - cloudbench
  - image-build
  - postpush-metadata
  - redundant-retry
  - published-tag
sources:
  - PR #1299
  - agent /root/cold_image_startup owning CLI reproduction
  - agent /root/cold_image_startup official Fly v0.4.112 final ImageInspectWithRaw source review
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_published_tag_completion_prevents_only_proven_rebuild
status: fixed
---

## Problem

An immutable, uncached native build from source `871e2949` installed its
dependencies, assembled its image, and completed the registry push. The producer
then failed while inspecting the image through the remote builder. The wrapper
started build attempt two, potentially repeating the entire cold build. The
parent canceled only the exact owned local build process before that second
attempt reached a Docker step. No shared builder was resized, reset, or deleted.
The original diagnostic remains failed and earns zero successful cold timing
credit.

## Diagnosis

The bounded private classifier found the final inspection wrapper and the
builder authorization refusal immediately after `Pushing image done`. Official
[Fly v0.4.112 source](https://github.com/superfly/flyctl/blob/v0.4.112/internal/build/imgsrc/dockerfile_builder.go#L287-L305)
calls `ImageInspectWithRaw` after `pushToFly` succeeds and the push-completion
event is printed. That inspection has a distinct failure boundary from registry
publication. The reason the external builder refused this later request remains
unproved; this case does not attribute it to token expiry or change permissions.

The same official client's authenticated prebuilt-image SDK path resolved the
exact owned full-image tag in 2.195 seconds, without pushing or activating a
Machine. During a separate supported warm setup, the actual full-image guest
consumer passed in 3.136 seconds (12.732 seconds including SSH): Linux AMD64,
eight input hashes, required executables and hoisting markers, generated Prisma
constructor under the runtime user, venv imports under that same user, pgvector,
ngrok, and cloudflared. It performed no database, browser, or model calls. The
generated Prisma schema text differs after generation; that formatting difference
was recorded as metadata rather than made an artificial rejection gate.

Archive searches were `You are not authorized to use this builder count not find
built image` and `image pushed final inspect metadata retry rebuild published
tag`. The HTTP-failover missing-host case was the closest relative, but its
original large push did not finish and its fallback concealed the first error.
The present event completed publication and then failed on final inspection;
these are distinct boundaries. Selected-context and duplicate-artifact-copy
cases concern earlier work and do not repair this retry decision.

## Solution

For the native publisher only, the helper recognizes the exact completed-push
marker followed by the known terminal final-inspection error. Recovery also
requires the invocation's fresh owned image label, PID, app, selected context,
config, and Dockerfile to agree. It asks the verified official SDK to resolve
that exact tag through `deploy --image ... --build-only`, with no `--push` and
no Machine activation. An unsuccessful resolution remains a failure.

When resolution succeeds, the wrapper returns a verified publication receipt
and a metadata warning instead of rebuilding the image. The receipt retains the
original publisher exit code, explicit SDK-resolution verification, and build
attempt count. It does not claim that the underlying builder inspection became
healthy. An unsuccessful completion-receipt write also remains a failure.

Per-attempt publisher and resolver logs stay private with mode 0600. The CLI
prints their location and bounded status information; it does not replay raw
forensic output. Task definitions, dependency versions, installed artifacts,
models, prompts, evaluation, runtime timeouts, and ordinary Fly operations are
unchanged.

## Verification

The owning actual-shell CLI controls initially failed all seven cases against
the original wrapper in 2.45 seconds; unchanged controls passed in 2.96 seconds
after the scoped repair. They cover the known post-push failure, the same error
before push, an unrelated error, unresolved exact tag, unchanged Depot behavior,
and normal native and Depot success. They inspect actual child invocations and
the durable receipt, including one publish attempt for recovered publication and
no push or lifecycle operation in resolution. A separate compact inverse covers
completion-receipt write failure.

The existing `cold_image` selector in `scripts/tests/benchmark-live-results.test.py`
permanently registers these controls in the quick deploy gate. The independent
review also required explicit receipt-write failure propagation and removal of
an optimistic verification default. Full-image SDK and guest evidence establish
artifact availability and essential consumer compatibility, while the original
producer diagnostic remains unsuccessful. A future accepted cold timing must
come from the final supported CLI, not relabel this earlier failure.

Final complete image CLI coverage passed 32 controls in 5.42 seconds. The
receipt-write inverse first failed against the draft that ignored writer status
in 0.49 seconds and then passed unchanged. Independent review passed all eight
completion controls in 3.24 seconds and approved the narrow source and archive.

## Human feedback

The user requested quick, cemented deploy controls, visible startup timings,
unchanged benchmark results, and useful parallel work. The controller owner
required exact-tag verification rather than treating a pushed log marker alone
as success. Independent review required receipt-write failure propagation and
removal of an optimistic publication-verification default.

## Reusable lesson

Resolve the exact owned published artifact before repeating an expensive build
when the producer fails only during final metadata inspection.
