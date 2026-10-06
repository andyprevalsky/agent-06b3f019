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
repro: matched 285-byte old/fixed native publication controls plus agents/benchmarks/cloudbench_image_cli_test.py; original masked large push remains open
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

An unchanged 285-byte fixture reproduced the endpoint defect with v0.4.76 in
16.365 seconds. The task-private official v0.4.112 release removed that error,
but its embedded BuildKit client encountered a distinct HTTPS h2c-upgrade
HTTP 500 boundary after 5.899 seconds. Changing only the supported
`DOCKER_BUILDKIT=0` child environment then built and pushed the same fixture
successfully in 17.387 seconds. Both versions used `--wg=false`, the same
configuration, inputs, and shared native builder, with one 90-second bound.
The repaired SDK's authenticated prebuilt-image consumer then resolved the
exact owned tag in 3.307 seconds without publishing or creating a Machine.

Native inventories before and after confirmed the same one builder Machine and
unchanged complete configuration fingerprint. Its normal stopped-to-started
transition is excluded from configuration changes. These controls earn zero
benchmark or large uncached-image credit. The cause of the original large
registry push failure remains hidden by Fly's failover; installed-artifact
parity and the full cold build remain unproved. This case remains open.

Archive searches used `cold image image export compression depot builder
startup` and `exporting layers uncached slow image remote builder`. The selected
context and repeated artifact-copy cases concern different earlier boundaries;
neither repairs the external client's endpoint construction.

## Solution

No shared Docker daemon, remote builder, account setting, global toolchain, or
WireGuard agent was reset or replaced. Image publication now automatically
prepares the official v0.4.112 client in the Git common directory's private
cache. The helper verifies the pinned official archive checksum, executable
version, and cached executable hash. Native publication uses the supported
classic Docker API and HTTPS transport only in the build child. Ordinary Fly
operations, caller environment, and global PATH remain unchanged. Setup uses
this same helper for its image publication only. The fleet's immutable script
snapshot includes the publisher library. The recipe contains no BuildKit-only
cache mounts; installed-artifact parity still requires the full cold build.

The existing image CLI now separately supports an explicit, image-build-only
`--builder depot` capability. Its exact provider arguments are
`--depot=true --depot-scope=app --compression=zstd --compression-level=3`.
The native default keeps its existing `--depot=false` arguments. Neither path
adds `--buildkit` or mutates the shared builder. Setup remains native.

Official Depot source uses an AMD64 builder and a literal `linux/amd64` export
target; it does not read native `FLY_DEV_PLATFORM`. The private image receipt
captures requested builder, scope, compression, level, platform, and selected
source/config/recipe hashes before provider launch. Native scope/compression
values remain null because the CLI does not override them. The receipt also
records publisher version, transport, and engine. Image-only builds
skip repository GitHub-token export; they retain Fly authentication.

Compact permanent controls execute the actual CLI/helper with offline providers.
Eight controls failed against unchanged source before this capability was added.
A platform-override control then caught a draft provenance error, and an actual
env-writer control caught the inherited image-only env mutation. After repair,
all 18 controls passed in 1.09 seconds; native behavior and setup env export
remain covered. This file was already registered in the existing compact
benchmark deployment owner. Six additional owning controls exercise verified
installation, warm reuse, corrupt-cache replacement, checksum/version rejection,
and transport/environment scoping. All 24 controls passed in 2.27 seconds and
remain registered through the existing test module. These compact controls
supplement the actual tiny native publication; they do not establish full cold
artifact parity or benchmark acceptance.

The supported `scripts/run-bench image-build --no-cache --builder native`
command then completed the same tiny fixture in 31.556 seconds, including the
automatic official publisher download and verification. It made one build
attempt, published successfully, emitted the expected source/recipe and
publisher receipt, and preserved the builder's complete configuration. This
confirms the CLI wiring without claiming a full cold-image time or runtime
compatibility. The final image and immutable-snapshot owner controls passed
25 tests in 4.41 seconds; formatting, shell syntax, and diff checks passed.

The Depot path exports OCI images. The existing setup guidance records a prior
OCI-index resolution incompatibility, so actual tag resolution, architecture,
installed runtime/input parity, and Machine consumption must be verified before
using the image for the fifty-wide run. No live Depot build, provider activation, or
measured Depot speedup is claimed by this change. Integrated current pricing has
not been established here.

Private evidence is retained at:

- `.context/acceptance/startup-speed-20261005/baseline-image/build.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-owning-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-platform-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-only-auth-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-builder-owning-final.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/old.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/fixed.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/fixed-classic.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/resolve.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/builder-before.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/builder-after.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/image-publisher-owning-red.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/image-publisher-hook-green.private.log`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/cli.safe.json`
- `.context/acceptance/fleet-stage-speed-20261006/native-host-publication/cli-output/cloudbench-image-build.json`
- `.context/acceptance/fleet-stage-speed-20261006/image-publisher-checkpoint-final.private.log`

## Human feedback

The user requested genuinely uncached image startup measurements, unchanged task
results, bounded permanent deployment controls, and improvements available through
the supported CLI. The controller owner prohibited resetting or resizing the
shared builder and required diagnosis before another cold install. Failed
diagnostic elapsed time must remain visible without being credited as a speedup.

## Reusable lesson

Preserve the remote endpoint when reconstructing a failover client, and retain the original failure before treating the fallback's error as its cause.
