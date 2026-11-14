---
id: 2026-10-28-it12-launch-wrapper-omitted-image-receipt-digest
date: 2026-10-28
title: It12 operator wrapper omitted the mandatory image receipt digest
surface: infra
component: benchmark-operator-launch-environment
classification: our-bug
problem_class: other
first_bad_boundary: Private launch wrapper exported the image-build receipt path but omitted CLOUDBENCH_IMAGE_BUILD_RECEIPT_SHA256 from the child environment
symptoms:
  - Fresh-storage image dependency admission refused missing pinned image-build receipt SHA256
  - Two original infra jobs crossed the configured two-of-thirty stop threshold
  - No startup cohort released and no scored workload result
tags:
  - i36
  - it12
  - operator-binding
  - image-receipt
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
repro: Original wrapper diff and inert child environment capture; unchanged image guard refused missing digest
status: fixed
---

## Problem

Original incident clock is22:48:07.240742Z on2026-10-28. It12 ran the original
30-job schedule on source765caac00ce085dd0359b8342161a8717be7446d. The private
launch-once wrapper checked the image receipt file's bytes and exported its
path, but failed to export the second mandatory child variable,
CLOUDBENCH_IMAGE_BUILD_RECEIPT_SHA256. Checking bytes in the parent process
did not supply the digest to the child that owned image admission.

The unchanged guard correctly reported:
`Fresh-storage image dependency admission refused: missing pinned image-build receipt SHA256`.
Original jobs r001-j0010/polar-bu-060 and r001-j0012/polar-bu-062 crossed the
configured two-of-thirty infra stop threshold. Final summary retained2failed
and28cancelled, not task PASS results. Startup release remained zero.

## Diagnosis

The root reviewed original30-job summary and16 immutable fleet-audit digests
from the normal exported originals. All16 started controllers had empty fresh,
expected and owned-resource registries, with zero resource rows and preserved
failed lifecycle states. Fourteen jobs never started. This is evidence of
nonallocation at the recorded admission boundary, not an account-wide provider
or external-session absence claim.

The supplied original guard receipt SHA256 is
61ef05fa97d66f18fa06a7c745e6ad50771a7e33e12b8d0386048475c9b67cdf.
It binds summary SHA256
32c7b22e6ad172091257fd4522874ebac8db727ee278e5f64b03fcd02b4f4f14
and multiple exact log lines with the missing-digest refusal. The later terminal
nonallocation receipt SHA256 is
20e4470af26eb89b1c548f40ed05e6e4325a9b3cfd3de0e12d9fb43b692ffcc6;
it binds final summary SHA256
460d14b85479215d408e3031f60a41436d18788f35c8986516ce86e079fd3406
and original finish22:50:04.265515Z. It records the original operator absent,
zero released cohort members and no scored-task credit. Failed lifecycle
records are not rewritten as successful runtime cleanup.

The private wrapper diff contains one corrective environment assignment:
export the already-verified digest alongside the already-exported receipt path.
Receipt file SHA256 remains
81aa445edb28821ebf31c26639e78824a5ac2ccf8f529b9040e3b2c4fb37bd05.
The source guard, image, dependency fingerprints and provider selection did not
need modification. This was not evidence of a bad image, missing provider key,
staging failure or a need to rebuild/reactivate anything.

## Solution

The parent reviewed the exact corrected private wrapper, child environment,
source and argv before authorizing a new invocation. An inert child capture
verified that both image variables arrived and matched actual file bytes.
Its receipt SHA256 is
08fc195749b1dded19cf4004bfb969ed5e71c698ee59638f05e18276a43b9bc2.
The captured command retains the same30original jobs, k2, concurrency16, strict
barrier, task timeout7200 and outer timeout10020. This capture ran no provider
guard, created no hold, and launched no benchmark.

The corrected wrapper SHA256 is
b06a3cf7f7278409fff4b714e1796ed9f67527e74a16761d3b6b9dc248bc7102.
A new invocation used a new directory/idempotency identity
`polar-it13-go-765-30c16-pinned-once` and its own future hold binding. It did
not reuse It12's identity or cancelled hold. It13 was authorized only after the
parent reviewed It12 terminal/nonallocation evidence and the new binding.

The later actual normal canary log at source765caac records at line29:
`fresh-storage baked image dependencies match the current ref`.
Its observation receipt SHA256 is
a217a3648bd4eeeee9ea4ea36eb2685558e1f0153662c23d2f86f2f519f60f10,
binding log SHA256
0bc16fb521b249df1ec8b8cf82c94b0b7e0fe83d97704a3294d17d70b2332f6f.
This verifies passage through the existing image guard after the binding
correction. It does not prove the whole canary, barrier, task or benchmark
succeeded. Original It12 failure, counts and clocks stay visible.

No repository runtime, harness, policy or test change was required. No new
paid causal task run is claimed. This record preserves the existing operational
correction and its evidence; It13's live execution remains separately owned.
The effective outer-bound reporting concern is separate from this missing
child-environment assignment and is not diagnosed here.

## Human feedback

Before GO, review the actual executable wrapper's child environment, both
mandatory image pins, exact file SHA, argv, source and an inert child capture.
A parent-only assertion is not an exported child binding. Do not reuse
idempotency identities, directories or holds for a replacement invocation.
Do not weaken the admission guard or change the batch/ramp to conceal failure.
Preserve the original incident clock through handoffs and keep investigation
bounded. This docs-only author made no native, provider, model, DB or browser
calls; tokens UNMETERED.

## Reusable lesson

Validate what the launched child receives, not only what its parent checked.
When an unchanged guard catches a missing required binding, repair that
operator binding and verify it without relaxing the guard or inventing success.
