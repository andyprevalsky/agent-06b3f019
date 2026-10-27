---
id: 2026-10-27-fresh-storage-admitted-volume-only-dependency-proof
date: 2026-10-27
title: Fresh REAL storage admitted a volume dependency proof while consuming an incompatible baked image
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet warm_deps_preflight accepted snapshot dependency proof for fresh storage consuming /app
symptoms:
  - Both canary guests failed dep_sync before the start barrier
  - Controller reported warm snapshot dependency trees matched the current ref
  - Guest rejected warm image/volume JavaScript dependency identity
tags:
  - cloudbench
  - dependencies
  - fresh-volume
  - image
  - polar
  - i19
sources:
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
  - fleet run 20261027-230015-2010044
  - commit d6ad54228cec845c3dc5708e08bcced54be65e61
repro: TMPDIR=/var/tmp agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_image_dependency_contract_test.py
status: mitigated
---

## Problem

Polar iteration 5 used source `d6ad54228cec845c3dc5708e08bcced54be65e61`.
Canary fleet `20261027-230015-2010044` admitted snapshot
`vs_0DGOJv5qy7Rt99OgZN99`, refreshed at source
`56ad8146f3decdca1d3ff427eda9327cac4f52c0`. Both guests
`896390b6059658` and `8dee50ce105798` failed JavaScript dependency synchronization
at 23:07:15 UTC before the barrier. Saved primary logs bind both guests to image
`registry.fly.io/navi-whisper-lux-bench:cloudbench-warm-20261013-121453-4063882@sha256:7e54062d66bf548a7075ad4fdff10f0fcd4f5eba9dcf1cafea11740ebbb696bf`.

## Diagnosis

Fresh REAL volumes bootstrap an empty checkout and use `/app` as dependency
donor. `--refresh-deps` updates and fingerprints `/data/repo`, then snapshots that
volume; it does not replace the image's `/app`. The controller accepted this
volume proof without establishing image compatibility. The guest correctly
failed closed: its installed marker was absent or different, and its actual
donor fingerprint differed from its requested checkout. The original marker,
image source SHA, and donor manifest hashes were not captured. Image age alone
is not proof of particular stale fields. The script-only `56ad` to `d6ad` change
has unchanged semantic identity; earlier `b085` to `56ad` changed E2B dependency
and tracked lock inputs. Do not infer the precise baked dependency set.

## Solution

The registered regression executes actual dependency synchronization: a central
volume refresh succeeds, a fresh checkout still rejects the incompatible image
donor, and a matching donor succeeds. Network installation is mocked; native
filesystem synchronization and semantic fingerprint functions execute. Ordinary
and private source namespaces exercise the actual controller gate. Original
source: 31 failed, 7 passed. Exact reviewed draft: 38 passed. The exact wrapper
selector collects all 38 controls.

The existing image-build receipt now records semantic Node/Python identities
from the selected context and refuses changed endpoint inputs before writing a
receipt. Fresh REAL admission requires an explicitly checksum-pinned, verified
publication receipt with matching published image digest and semantic identities.
Volume proof cannot substitute. Snapshot/SIM validation stays in its existing
namespace. Failure diagnostics retain rejection and report hashes and paths.
Canonical build/activate commands and receipt exports are documented in
`benchmark.md` and `descend.md`; no hand-authored receipt or snapshot fallback.

Independent opened-reference review `I19v3 GROUNDED` covers exact nine-path patch
SHA256 `2c5c3af2b69fc2dbe4820074bb314cf73c96fbaedc6d02c92469dc1fd289732f`
against `d6ad54228`. Reviewer independently ran all 38 controls. A test-only owning-fixture supplement was independently grounded as I19v4:
full patch SHA256 `85be31808a2f74d0061427823433a57c2ca3bb2e12d9879c8797751cb194a535`,
supplement SHA256 `3c4e1636d2c12996fa56e74bc61defb23007c938be63d49ed2dbe40e666c6753`.
It supplies the same valid dependency manifests to two existing image-build
fixtures; assertions and runtime bytes are unchanged. This case file is
truthful documentation added after protected patch review.

## Limits and remaining operational work

This source mitigation does not replace the historical image or establish a
successful benchmark. Parent owns one supported isolated benchmark image build
and activation, followed by actual guest image digest verification. No image,
provider, paid run, production deploy, task definition, or Freedom mutation was
performed by this owner. Original normal teardown and resource release belong
to launch-owner receipts, not this source change.

Pre/post build fingerprints detect endpoint changes, not concurrent ABA or an
atomic build-context snapshot; existing frozen-context requirements remain.
Admission validates observed source inventory, not an atomic provider freeze
through the later clone. The guest remains fail-closed. Host-local receipt pins
inherit through ordinary campaign children; remote sharded transport is separate
I20 work and is not claimed ready here. Local pinned receipt trust is the
existing publisher output, not hostile-party attestation or package correctness.

## Human feedback

Parent required preserving semantic dependency identity and fresh REAL defaults,
using the supported benchmark image workflow, and separating remote transport
into I20. The original script-only mismatch hypothesis was not confirmed.

## Reusable lesson

Dependency proof must bind the artifact actually consumed by the selected
storage mode. A valid mutable-volume receipt cannot establish immutable-image
dependency compatibility. Preserve fail-closed guest validation and collect
identities at the failing boundary rather than inferring them from image age.
