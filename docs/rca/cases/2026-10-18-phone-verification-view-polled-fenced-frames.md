---
id: 2026-10-18-phone-verification-view-polled-fenced-frames
date: 2026-10-18
title: Phone setup verification polled forbidden frames and displayed connection errors
surface: front-end
component: phone-overlay-verification-observer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: usePhoneOverlay polled frame after recovering a nonterminal setup.verify receipt
symptoms:
  - Connecting to the phone
  - Phone state changed. Refreshing; no input was replayed.
  - Frame GET observed during RUNNING or UNKNOWN setup.verify
tags:
  - phone-harness
  - setup
  - frame-polling
  - semantic-verification
sources:
  - commit 90dafae20b76d6e9f992abc1de9dc45e7ca77c42
  - task Goal6c first-use setup integrated visual review
repro: front-end/src/tests/blackbox/phone-attention.blackbox.tsx
status: fixed
---

## Problem

The new setup verifier reserves the existing command slot while the model checks
server-loaded observations. Backend owning tests intentionally require frame
GET to return 409 during that interval. The frontend nevertheless read the
operation status, then requested a frame. Actual mobile fixture review showed
the correct header with a contradictory Connecting to the phone placeholder and
state-change warning. No live phone, credential, provider or model call occurred.

The first private visual fixture incorrectly expected an image during verification
and omitted the operation-status response. That fixture was corrected to return
RUNNING from the exact operation GET and 409 from frame GET before evaluating
the actual UI behavior. Its initial image-visibility failure is not causal proof.
The normal owning test below supplies that proof.

## Diagnosis

Archive searches were Phone state changed setup verification frame and pending
semantic operation frame poll. The existing phone-overlay-reads-bypassed-durable-
custody case is a relative: it fixes backend custody, whereas this issue is a
frontend observer ignoring a known custody state. Read-only reference searches
in Claude Code, Codex TUI, OpenClaw and Hermes CLI found no setup.verify phone
protocol counterpart; the actual Rose route contract is authoritative here.

Hypothesis: recovering a RUNNING or UNKNOWN verification receipt does not alter
the unconditional ACTIVE-lease frame branch. Prediction: an otherwise correct
status-only observer still emits frame GET and renders connection copy. Falsifier:
zero frame calls and a verification placeholder with status recovery continuing.

The existing registered suite was extended before the fix. Exact command:
`cd front-end && npx vitest run src/tests/blackbox/phone-attention.blackbox.tsx -t 'fenced'`.
At 22:34:15 UTC both RUNNING and UNKNOWN cases failed: frame request observed
true, expected false. Duration 2.12s; log
`.context/phone-harness/goal6c-verification-red.log`. The same command and assertions
passed 2/2 after the fix, 5.54s, log goal6c-verification-green.log. This is a local
UI/protocol regression, not a failed live benchmark or a claim of Apple sign-in.

## Solution

The existing observer recognizes the exact setup.verify operation and its
nonterminal status. It revokes the previous frame, clears bounds, skips frame
RPCs and continues the same sequential operation-status reads. The overlay shows
Verifying phone sign-in. Input remains disabled and no command is resubmitted.
The owning tests also check repeated status GET, zero frame requests throughout
the fence, and disabled takeover. All six owning suites passed 74/74, with
TypeScript, ESLint and formatting passing.

At 10k agents this removes requests while fenced and adds one constant-time
task-local predicate. It introduces no polling loop, channel, shared registry,
per-user fan-in, mutation, provider grant or persistent state. Parent integrated
visual and full frontend gates are recorded separately before closure.

## Human feedback

None recorded for this bug. The standing request requires accurate mobile and
desktop phone UI and step-by-step validation.

## Reusable lesson

Render a known operation fence as its actual task state and observe its receipt instead of issuing resource reads that the fence deliberately rejects.

## Parent review closure

Adversarial read-only review confirmed the exact owning red/green proof and
excluded the incorrect initial image fixture from causal evidence. Frozen-source
whole frontend coverage passed170 files,2881 tests with3 existing skips in149.27s;
coverage81.57% statements,74.33% branches,82.01% functions,83.85% lines. Production
build passed18.40s. Actual browser fixtures passed15 native reason/read-only cases
and15 setup-state cases across1440x900,390x844 and320x568. Verification cases made
zero frame requests and rendered no stale image; available native phone pixels
remained at least155.17px wide. All setup fixtures made zero writes and all30
cases had zero page errors. Parent viewed the small mobile password and verifying
images directly. These fixtures establish UI/protocol behavior, not live sign-in.
