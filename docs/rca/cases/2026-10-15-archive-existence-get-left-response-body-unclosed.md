---
id: 2026-10-15-archive-existence-get-left-response-body-unclosed
date: 2026-10-15
title: Archive existence probe opened an unread ciphertext response
surface: agents
component: trace-archive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers/trace_archive.py read_r2_artifact_metadata used GET only to test ciphertext existence
symptoms:
  - StreamingBody opened by ciphertext existence probe
  - Missing sidecar probe leaves response body unread
  - "AttributeError: _FakeR2Client has no attribute head_object"
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit cce345d883547edde88b89f67b93590fbc83534c
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-transport/result.json
repro: agents/tests/unit/test_review_transport.py; agents/tests/blackbox/trace_archive.blackbox.py; agents/tests/blackbox/world_model_harness.blackbox.py
status: open
---

## Problem

An owning offline response-body control demonstrated an unclosed StreamingBody when the metadata path probed ciphertext existence without reading it.

## Diagnosis

The path only needed existence metadata, but GET allocated a body that neither the successful probe nor orphan handling consumed. This differs from waterfall leg-metadata commitment: the resource owner here is an R2 existence request.

### C5 consumer-fixture recurrence

C5 on `cce345d883547edde88b89f67b93590fbc83534c` exposed two registered WMH callbacks that still supplied a GET/LIST-only `_FakeR2Client`. Both original callbacks reproduced `AttributeError: '_FakeR2Client' object has no attribute 'head_object'`; adding HEAD alone then exposed the obsolete assertion allowing a ciphertext GET. This is consumer test-interface drift from the reviewed HEAD correction, not a new production R2 failure. The original agents log SHA256 is `3cd39c025cd1f7236237ec4e5a980bc9e4b2ae5ff3689d4e8ee0b5fd657fda50`.

The shared fake now follows the installed S3 HeadObject contract: metadata without a response body, and the same missing-key envelope. The existing metadata callback strengthens its assertion to zero ciphertext GETs plus the exact missing-object HEAD. A registered fake-parity case forbids internal GET/body access. Identical strengthened callback assertions failed three times on the old fake and passed on the corrected fake; the related seven-case family passed in 0.223 seconds. Production error/orphan handling, exporters and archive checks are unchanged. The private final diff is `d8027c55f80f2351712c4f1d34862e9795a2d459e5b23337f233bec75f061fd4`; root applied verification and final normal gates remain required.

## Solution

The correction uses HEAD for the existence probe and retains the actual sidecar GET and absent/orphan/error behavior. The transport review batch had 9 failures/12 passes before and 21 passes after using the same assertions SHA256 61e944ac0d6827c82f154516aac5450fa0b6bdbb47a9dd56e21bcd7ae5da53c3. Batch pytest walls were 0.570s and 0.265s; parent reported 21 applied controls passing. No production R2 request or archive mutation was performed by this proof.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `b059edbd21cb33aa4afe9618e707c0f49ec63f21788969507ee32a6e82c8497e`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Use metadata-only requests for existence checks instead of allocating bodies that the caller will not consume.
