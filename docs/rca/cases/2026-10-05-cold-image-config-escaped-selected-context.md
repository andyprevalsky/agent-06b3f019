---
id: 2026-10-05-cold-image-config-escaped-selected-context
date: 2026-10-05
title: Cold image build selected the controller checkout through its Fly config
surface: infra
component: cloudbench-image-build
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: build_warm_image passed the controller's Fly config alongside a different selected build context
symptoms:
  - an original serial baseline recipe produced the current multistage candidate image
  - positional build context and explicit Dockerfile did not establish the selected checkout
  - the image receipt captured HEAD after the provider build
tags:
  - cloudbench
  - image-build
  - working-directory
  - source-provenance
sources:
  - PR #1299
  - agent /root/cold_image_startup owning reproduction and independent review
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_build_keeps_provider_cache_bypass_and_context
status: fixed
---

## Problem

The first native uncached build was intended to use an original baseline checkout.
That checkout contained the original serial recipe, with SHA-256
`c038b0516e58b4fc8d1d1a6644d8ca8bb131413f9eddc5b5f1167bfd2b4e5f1d`.
The provider instead reported `native-base`, `javascript-dependencies`,
`python-dependencies`, and `runtime` stages from the controller's current candidate.
The submitted job was retained as a candidate diagnostic, with zero baseline
comparison credit. No benchmark or Machine was launched by this image build.

## Diagnosis

The image CLI forwarded the selected absolute context and Dockerfile, but
`build_warm_image` still passed `-c "$ROOT_DIR/fly.cloudbench-warm.toml"` and ran
from the controller checkout. Fly's config-directory resolution therefore selected
the controller's source. A fake provider executing the unchanged real helper
confirmed that both its config path and invocation directory disagreed with the
selected context. The first bad boundary was build invocation ownership, rather
than layer-cache reuse or the candidate recipe's dependency graph.

The receipt also read `git rev-parse HEAD` after the build, omitting recipe/config
hashes and dirty status. It could therefore attribute subsequent edits to already
submitted inputs. This was a provenance gap, separate from image artifact parity.

Archive searches used `Fly cold image config build context selected checkout` and
`working directory selected source fingerprint wrong checkout`. The related
`2026-07-23-npm-prefix-substitutes-package-identity` case reinforces that explicit
path flags do not replace the tool's working-directory semantics. The warm-image
fingerprint and controller-local snapshot cases address different boundaries.

## Solution

Validate the selected checkout's Dockerfile and Fly config, resolve its physical
path, and invoke Fly from that directory with both explicit paths in the same
checkout. Preserve native remote builds, unique labels, layer-cache bypass, and
the rejection of prebuilt images when `--no-cache` is requested.

Capture the selected source HEAD, dirty status, Dockerfile SHA-256, and config
SHA-256 before provider launch. The private receipt retains these hashes and the
selected context without copying file contents. These are pre-launch input
observations; they do not certify edits made after upload or installed image
artifact equivalence.

The permanent controls execute the actual helper with a fake provider and assert
its cwd/config/Dockerfile paths. A second control changes the fixture recipe and
advances its HEAD during the provider call; the receipt must retain the earlier
inputs. Unchanged assertions failed in two cases before repair and all seven cold
CLI cases passed afterward. An independent reviewer approved the fix and reran
all seven controls. They are registered under `cold_image` in the existing
`scripts/tests/benchmark-live-results.test.py` deploy owner.

Matched native cold image comparison remains separate work. The wrongly selected
first build cannot establish a baseline or a measured speedup. At fleet scale,
this validation runs once per image build and adds no per-agent work.

Private evidence is retained at:

- `.context/acceptance/startup-speed-20261005/baseline-image/build.private.log`
- `.context/acceptance/cloudbench-image-context-owning-red.private.log`
- `.context/acceptance/cloudbench-image-context-owning-final-green.private.log`
- `.context/acceptance/cloudbench-image-context-independent.private.log`

## Human feedback

The user requested startup measurements from a genuinely uncached edited-worktree
run and prohibited result changes or cached work being credited as a cold speedup.
The submitted diagnostic must remain visible without restarting unrelated resources.

## Reusable lesson

Bind a build tool's config, recipe, context, and working directory to the same
selected checkout. Record input hashes before launch, and confirm native stage
output before calling an image a baseline.
