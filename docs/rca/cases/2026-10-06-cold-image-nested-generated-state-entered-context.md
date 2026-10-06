---
id: 2026-10-06-cold-image-nested-generated-state-entered-context
date: 2026-10-06
title: Cold image context included nested generated workspace state
surface: infra
component: cloudbench-image-build
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: Docker context filtering excluded root generated state but retained nested .context directories
symptoms:
  - source context transferred 846.54 MB in 182.5 seconds
  - controlled nested generated-state markers survived COPY into the image
tags:
  - cloudbench
  - image-build
  - dockerignore
  - packaging
sources:
  - commit 71241f2ef38162553df25d81d2e56c848e265aab
  - agent /root/final_basic_cli_validation fresh basic CLI native build receipt
repro: agents/benchmarks/cloudbench_image_build_test.py::test_cloudbench_image_build_actual_context_excludes_nested_generated_state
status: fixed
---

## Problem

A fresh-context agent used the documented uncached image CLI. The native builder
transferred 846.54 MB in 182.5 seconds. The complete build and publication took
483.683 seconds, followed by 165.854 seconds of normal activation. These stages
sum to 649.537 seconds; actual build start through activation end was 790.034
seconds, including a separate 140.497-second engineering hold. No fifty-copy
execution or task outcome receives credit from these measurements.

A read-only file-size inventory found 400,854,481 bytes in 626 files under
`agents/.context`, plus smaller nested generated-state directories. Only file
metadata was examined. The original `.dockerignore` excluded root `.context`
and `.llm-dumps` but did not exclude their nested counterparts.

## Diagnosis

The path is selected checkout → Docker ignore filtering → uploaded build archive
→ `COPY .` → published image. A controlled local fixture exercised actual Docker
context packing and copying; it contained only generated dummy markers and
required runtime/history sentinels. It never copied the real private workspace.

On the original ignore file, the build reached `COPY . /ctx` and the unchanged
`RUN` assertions, then exited 1 because nested generated-state markers remained.
Adding recursive generated-state exclusions made those same assertions pass in
2.498 seconds. Required runtime and task-history files remained present. The
native transfer measurement establishes the symptom; the actual Docker fixture
establishes filtering causality. The subsequent uncached CLI comparison below
measures the complete build rather than inferring speed from archive size.

Archive searches used `Docker build context .context generated nested upload`
and `846.54MB context transfer dockerignore image source packaging`. The October 5
selected-context case is related but concerns Fly invocation ownership. Its
solution binds config, recipe and cwd to one checkout; those bindings were
correct in this run. This is a different first-bad boundary.

Private evidence is retained under
`.context/cold-context-nested-state-20261006/` and
`.context/final-basic-cli-validation/`. The exact stopped failed fixture container
was inspected, removed and independently observed absent. No unrelated Docker
resources were pruned.

## Solution

Extend the existing exclusions to `**/.context` and `**/.llm-dumps`. Keep complete
runtime source, dependencies, task definitions, current metrics, task-selection
history and runtime assets. No prompt, model, evaluator, execution timeout,
production setting or task-result contract changes are involved.

The checked-in control uses the real Docker client to upload a synthetic build
archive to an ephemeral loopback receiver, without a daemon or real workspace
inputs. The unchanged control failed on the original ignore file because
generated markers entered the archive, then passed after the fix. An overbroad
exclusion inverse failed because required runtime bytes disappeared. Actual
client calls took approximately 0.07 seconds each; the independent unchanged
owning pytest control passed in 0.45 seconds. All eight inherited proxy keys were
preserved. No external requests or image builds were added to this quick test.

The existing unconditional `scripts/tests/benchmark-live-results.test.py` deploy
gate selects this test through its image-owner selector. The same gate runs from
`scripts/test.sh` and `/deploy` Step 4s, including for an ignore-only edit; no
additional paid run, native controller suite or classifier change is needed.
The independent reviewer approved the production diff, reproduction and narrow
diagnosis; Ruff format/check and source whitespace checks passed.
The unchanged normal quick owner discovered and passed 174 controls in 61.309
seconds; its exact process, Docker client children and receiver were retired.

A second fresh-context agent then used only the basic documented CLI. Its
clean pre-launch source was `9efb3dfa64ac71403e31d65612d21bdd74752f05`.
The one-attempt no-cache build and publication completed in 285.500 seconds;
the same Depot app scope, zstd level 3, Linux amd64 platform, pinned publisher,
recipe and config were retained. Dependencies installed in 123.4 seconds,
source copied in 15.3 seconds, and export/push took 75.9 seconds. The baseline
was 483.683 seconds: these two complete invocations differ by 198.183 seconds
(41.0%). This is one observed comparison per side, rather than a repeatability
guarantee or an attribution of every timing difference to the ignore rules.

The final builder log reports 1.78 MB transferred in 1.4 seconds. That is
transported context, not the logical size of all runtime files. Provider-retained
content was not evicted; image layer reuse was disabled normally. Ten tracked
recipe/dependency inputs match between the baseline and candidate. The existing
ignored root npm lock was not edited and its modification time precedes both
builds, but a baseline content hash was not captured for it.

Normal exact-image activation took 158.589 seconds. Native inventory verified
donor `683e47df5094d8` stopped on its original volume with manifest
`sha256:ff89d601f928e032dc3cbc22430e5d725fc04a535aafcb4e02929652e1115d91`.
The image-build receipt captured clean `9efb3dfa`; activation requested clean
`32a1c951acd6b67dac817ec3ed9636656bf09a30`, which differs only in an existing
RCA result paragraph. Those sources are recorded separately. Activation's
accepted output directory contains no native receipt, so the independently
captured owner, exit and inventory evidence establish this result without
claiming a full donor Git HEAD verification.

Build plus activation sum to 444.089 seconds (7 minutes 24 seconds), versus
649.537 seconds previously. Actual build start through activation end was
519.977 seconds, including the separate 75.889-second verification gap. Stage
durations may overlap internally and are not summed as native layer totals.
These proofs establish the packaging correction and actual cold CLI timing;
the production fleet and benchmark outcome remain separate required work.

## Human feedback

The user requested substantial startup improvements through the documented CLI,
independent verification using only basic CLAUDE instructions, compact permanent
deploy tests, and no result changes or expensive automatic verification.

## Reusable lesson

Exercise actual packaging with generated-state and runtime sentinels before
measuring the whole cold build; root-only exclusions cannot establish nested
directory filtering or whole-build latency.
