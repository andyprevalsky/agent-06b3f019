---
id: 2026-10-05-native-image-http-failover-forgot-daemon-host
date: 2026-10-05
title: Native image publication failed over to a client without its remote daemon host
surface: infra
component: cloudbench-image-build
classification: third-party-failure
problem_class: other
first_bad_boundary: Fly v0.4.76 buildWireguardlessClientOpts omitted WithHost when reconstructing the remote Docker client
symptoms:
  - image export completed and registry push started but never completed
  - failed to parse daemon host with missing hostname during builder heartbeat
  - later retries also encountered a changed checkout's missing install helper
tags:
  - cloudbench
  - image-build
  - remote-builder
  - http-failover
  - daemon-host
sources:
  - PR #1299
  - agent /root/fleet_stage_speed source diagnosis and CLI controls
  - commit 2bc89faa78b138c2de63922ce1ac1472e424c916 upstream host preservation repair
repro: agents/benchmarks/cloudbench_image_cli_test.py tests the opt-in capability only; native publication reproduction remains open
status: open
---

## Problem

The native uncached diagnostic ended unsuccessfully after 1,686.75 seconds.
Dependency installation and image export completed; export took 253.1 seconds.
Registry push began but no push-completion event followed. Fly then entered a
second image-resolution path and ended with a daemon-host parsing error during
the remote builder heartbeat. No usable image receipt or benchmark run resulted.
The attempt has zero successful cold-build or benchmark credit.

The diagnostic also used the wrong selected checkout, as recorded separately in
[the context ownership case](2026-10-05-cold-image-config-escaped-selected-context.md).
Later wrapper retries picked up a recipe edit without its new install helper.
Those secondary failures cannot identify the original push error or establish a
matched cold-build baseline.

## Diagnosis

A private, strictly bounded classifier established that the failing daemon URL
was the default local Unix Docker socket, with no hostname. Only event classes,
line numbers, and the recognized endpoint shape were emitted; no raw logs,
credentials, request bodies, or configured remote addresses were exposed.

Official Fly v0.4.76 source explains the endpoint failure:

- `internal/command/deploy/deploy.go` retries a failed WireGuard build through
  HTTP failover and replaces the earlier error with the fallback's error.
- `internal/build/imgsrc/docker.go` constructs the HTTP client's API negotiation,
  authorization header, and TLS dialer but omits `dockerclient.WithHost(host)`.
  The client therefore keeps its default local daemon URL.
- `internal/build/imgsrc/resolver.go` derives the heartbeat endpoint from that
  client's daemon URL. `daemon_url.go` rejects an empty hostname before sending
  the heartbeat.

The upstream one-line repair, merged September 2, 2026, adds the missing host:
[Fly commit 2bc89faa](https://github.com/superfly/flyctl/commit/2bc89faa78b138c2de63922ce1ac1472e424c916).
The corresponding [upstream PR](https://github.com/superfly/flyctl/pull/5156)
also describes retaining the Unix socket by default. The reviewed v0.4.76 source
omits this repair; current upstream source includes it.

This establishes the secondary HTTP endpoint defect. The cause of the original
registry push failure remains hidden by Fly's failover. Neither a local runtime
reproduction of that SDK handoff nor successful publication using the repaired
client has been completed. This case therefore remains open.

Archive searches used `cold image image export compression depot builder
startup` and `exporting layers uncached slow image remote builder`. The selected
context and repeated artifact-copy cases concern different earlier boundaries;
neither repairs the external client's endpoint construction.

## Solution

No shared Docker daemon, remote builder, account setting, or global toolchain
was reset or replaced. A task-private Fly release containing the upstream repair
is a possible next native publication control. Any such control must distinguish
the original push failure from the repaired fallback, preserve the submitted
source snapshot, and verify the published image through the actual consumer.

The existing image CLI now separately supports an explicit, image-build-only
`--builder depot` capability. Its exact provider arguments are
`--depot=true --depot-scope=app --compression=zstd --compression-level=3`.
The native default keeps its existing `--depot=false` arguments. Neither path
adds `--buildkit` or mutates the shared builder. Setup remains native.

Official Depot source uses an AMD64 builder and a literal `linux/amd64` export
target; it does not read native `FLY_DEV_PLATFORM`. The private image receipt
captures requested builder, scope, compression, level, platform, and selected
source/config/recipe hashes before provider launch. Native scope/compression
values remain null because the CLI does not override them. Image-only builds
skip repository GitHub-token export; they retain Fly authentication.

Compact permanent controls execute the actual CLI/helper with offline providers.
Eight controls failed against unchanged source before this capability was added.
A platform-override control then caught a draft provenance error, and an actual
env-writer control caught the inherited image-only env mutation. After repair,
all 18 controls passed in 1.09 seconds; native behavior and setup env export
remain covered. This file was already registered in the existing compact
benchmark deployment owner. These are CLI/metadata controls, not proof that the
native SDK bug or live publication has been fixed.

The Depot path exports OCI images. The existing setup guidance records a prior
OCI-index resolution incompatibility, so actual tag resolution, architecture,
installed runtime/input parity, and Machine consumption must be verified before
using the image for the fifty-wide run. No live build, provider activation, or
measured Depot speedup is claimed by this change. Integrated current pricing has
not been established here.

Private evidence is retained at:

- `.context/acceptance/startup-speed-20261005/baseline-image/build.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-owning-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-platform-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-only-auth-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-owning-final.private.log`

## Human feedback

The user requested genuinely uncached image startup measurements, unchanged task
results, bounded permanent deployment controls, and improvements available through
the supported CLI. The controller owner prohibited resetting or resizing the
shared builder and required diagnosis before another cold install. Failed
diagnostic elapsed time must remain visible without being credited as a speedup.

## Reusable lesson

Preserve the remote endpoint when reconstructing a failover client, and retain the original failure before treating the fallback's error as its cause.
