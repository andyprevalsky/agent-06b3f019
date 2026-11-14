---
id: 2026-11-11-native-image-progress-hidden-from-publication-watchdog
date: 2026-11-11
title: Native Docker progress was hidden from the image publication output watchdog
surface: infra
component: cloudbench-image-publication
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: The native Docker SDK suppressed positive progressDetail messages on nonterminal stderr before the publication watchdog measured private-log byte growth
symptoms:
  - Image publisher produced no output for 360s; ending this attempt for the normal retry.
  - error rendering push status stream: terminated signal received
  - native SDK35 image attempts ended with publisher_exit_code 124
  - 2502c24814ea remained Preparing while the other 26 layers reported Pushed or Layer already exists
  - real underlying fixture transfer counters increased while the original wrapper returned 124
tags:
  - cloudbench
  - native-docker
  - publication-watchdog
  - progress-rendering
  - nonterminal
sources:
  - task AgentCard v2 readiness; artifact .context/agentcard-stability/cloud-smoke-a508-rca/native-progress-pty-20261111/receipt-final.json
  - task AgentCard v2 readiness; artifact .context/agentcard-stability/cloud-smoke-a508-rca/sdk-native-final-packet.json
  - task AgentCard v2 readiness; artifact .context/agentcard-stability/cloud-smoke-a508-rca/sdk-native-progress-suppression-source-review.json
  - task AgentCard v2 readiness; artifact .context/agentcard-stability/cloud-smoke-a508-rca/sdk-registry-rca/native-exact-image-measurement-packet.json
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_native_terminal_progress_reaches_actual_watchdog
status: open
---

## Problem

The source-ref `35a3cb1faa035f899ecaebc97c7f7279dd09c77d` native SDK build
completed all three built-in attempts without a verified image. Each attempt's
publisher returned 124 under the unchanged 360-second no-output watchdog. The
first stopped inside Docker Step 22 after the joined installers and npm cache
clean warning; the second and third built the same classic image and entered
push. The real Playwright owner import passed before the latter pushes. This
was one operator invocation, not three new operator launches.

In each retained push log, 27 layers were prepared and 26 reported `Pushed` or
`Layer already exists`; `2502c24814ea` lacked a terminal status. No raw Docker
JSON progress counters were retained, so the actual final 360-second transfer
liveness remains **unknown**. Signal-related stream and GraphQL finish errors
follow the watchdog; they are not independent proof of a remote failure.

The sole operational owner subsequently performed two authorized exact-image
GETs. Both returned 200. Image
`sha256:b96891797d406b6b9580d260911d18c0249e63c1d76c7327c00f068d11b31ae7`
measured 4,808,681,933 uncompressed bytes. The retained Step 22 image ID joins
exactly to a history entry of 2,275,366,507 bytes; Step 23 source copy measures
539,502,035 bytes. These are not compressed upload bytes, throughput, transfer
progress, or registry publication proof. No further image reads are authorized
by this record.

## Diagnosis

Path: normal native image publisher -> pinned Fly 0.4.112 classic Docker
`ImagePush` response -> pinned Docker JSON renderer -> redirected private log ->
existing log-size no-output watchdog -> exact-owned process-tree retirement.

The source-confirmed first loss of observability is before the watchdog:

- Fly commit `ca63052e2526df073e9a1a4ad57bcbe5892f0543` imports Docker
  `v28.5.2+incompatible` and passes `streams.IsStderrTTY()` to
  `DisplayJSONMessagesStream` in `dockerfile_builder.go:508`.
- The pinned Docker `JSONMessage.Display` returns without writing a message
  with a positive progress detail on nonterminal output. It still consumes the
  incoming stream. Preparing and completed status messages remain visible.
- The publisher redirects stdout and stderr to a regular private log. The
  existing watchdog observes that rendered file's size, not incoming Docker
  response bytes or counters.

Thus actual progress can be consumed without resetting the log-size watchdog.
A local owning-boundary reproduction proves this mechanism; it does not prove
that these historical remote pushes were progressing.

Step 5a: the watchdog mistakes hidden progress for absent output because its
producer intentionally selects a terminal-only progress format. That is a
producer/consumer observability mismatch, not evidence that the existing idle
bound is too short. Step 5b: preserve real producer progress at the existing
native boundary instead of adding a timer, heartbeat, retry, SDK replacement,
registry fallback, or weaker handoff. Depot's separate status producer does not
require this change.

Primary pinned sources:

- [Fly classic push and renderer call](https://github.com/superfly/flyctl/blob/ca63052e2526df073e9a1a4ad57bcbe5892f0543/internal/build/imgsrc/dockerfile_builder.go#L497-L518).
- [Docker nonterminal progress suppression](https://github.com/moby/moby/blob/v28.5.2/pkg/jsonmessage/jsonmessage.go#L165-L179).
- [Fly interactive and prompt checks](https://github.com/superfly/flyctl/blob/ca63052e2526df073e9a1a4ad57bcbe5892f0543/iostreams/iostreams.go#L170-L171).

Archive searches used literal `Image publisher produced no output classic
Docker progress` and behavioral `nonterminal progress suppressed PTY native
image watchdog`, plus direct filename/content searches. The 2026-10-12 Depot
silent-stream/reused-tag case is related but has a different first boundary:
unbounded waiting plus shared retry output identity. Its per-attempt labels and
idle guard remain strict here. The 2026-10-07 registry handoff case is also
related; its immutable manifest check remains unchanged. No existing case
identified the native renderer's terminal-only progress loss, so this is a new
boundary rather than a fork of those diagnoses.

## Solution

PRIVATE candidate `67a9feb7e26b6aea8ad70a4b923a2e8f9fa2301a24f8fa932d342947e8fc3e9b`
changes only the existing native classic publisher branch and its owning tests.
A stdlib PTY carries SDK stderr to the same private log, retaining the SDK's
actual transfer messages. Stdin is `/dev/null`; stdout remains inherited private
output. The pinned `IsInteractive` requires both stdin and stdout TTYs, so
making only stderr a terminal does not enable SDK prompts. Signals are forwarded
to the exact client; the relay closes its master and waits for the child in
`finally`. Existing birth-aware tree cleanup remains the retirement authority.

Unchanged: Depot branch, SDK/version/checksum, Docker flags, native transport,
360-second idle default, retries, unique attempt tags, strict registry handoff,
image contents, benchmark criteria, and task deadlines. No generated heartbeat
or claim of monotonic network progress is introduced.

Actual local evidence, same final test SHA
`0660f0f70a49db566211effc95a80b4c0900214fcb87e92c1d5b7c4aa740180b`:

- Original producer: the fixture records multiple increasing transfer events
  through an independent sink, while real nonterminal rendering hides them;
  the actual watchdog returns 124 instead of 0. One failure in 3.35 seconds.
- Candidate: six new expanded cases pass, including native/Depot transfer
  progress, closed stdin/noninteractive output, silent 124, native exit 37,
  signal 143, cancellation 143, and captured descendant retirement.
- Exact final candidate: the full existing module passes **104 tests in 88.13
  seconds**, exit 0, without skips. Syntax and whitespace/apply checks pass.
- The existing `scripts/tests/benchmark-live-results.test.py` already selects
  this module and its `cold_image` test prefix. No new gate is introduced.

The fixture models the source-reviewed Docker rendering contract with actual
`isatty` behavior and invokes the real wrapper/watchdog. It does not execute a
real daemon or compile the pinned Go renderer. No vendor, model, browser,
financial, database, or build calls occurred in these tests; only exact owned
local HTTP fixtures were admitted for the full existing module.

A separate unsupported-client probe (not part of the candidate's final tests)
exited its synthetic client with 37 while a forked helper kept stderr open. The
relay waited for EOF and the probe hit its 30-second fixture deadline. Its
fixture cleanup retired the owned helper; a subsequent exact PID audit found
both processes absent. Pinned current `--wg=false`/explicit-Dockerfile source
inspection found no retained-stderr descendant in the selected native path;
agent/background startup sets its standard streams to null. This is an
explicit generic inherited-slave limitation, not evidence of the historical
failure. Per coordinator scope, the exact candidate remains unchanged and no
new process architecture or additional repetitions were pursued.

The private source remains unapplied by this lane. Independent code review,
shared-source public validation, and the exact real publication outcome remain
parent-owned. Keep this case **OPEN**: mechanism proof does not establish the
historical transfer cause, a recovered published artifact, or deployment.

## Human feedback

The coordinator required no timer/cap increase, heartbeat, retry workaround,
PTY stdin, SDK change, or weakened publication check. Preserve all failed
attempts, unknown historical liveness, exact cleanup, and separate publication
proof. The coordinator scoped unsupported generic inherited-descriptor behavior
as a disclosed limitation after finding no applicable pinned native fork; no
process architecture expansion or further repeats were requested.

## Reusable lesson

Preserve authentic producer progress before using rendered-log silence as a liveness boundary, while keeping artifact publication and historical-cause proof separate.
