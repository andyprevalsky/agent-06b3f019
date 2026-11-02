---
id: 2026-11-02-r154-probe-cancellation-waits-for-abort-ack
date: 2026-11-02
title: Diagnostic probe timeout waits indefinitely for a Playwright abort acknowledgement
surface: agents
component: browser-cdp-stall-classifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "Probe timeout cancels Playwright Channel._inner_send, which awaits an unanswered Connection._abort acknowledgement"
symptoms:
  - A10ms probe remains pending after150ms in the actual SDK cancellation path
  - A diagnostic timeout can itself exceed the advertised deadline
  - Probe cleanup must retain exact request and connection ownership
tags:
  - r154
  - cdp
  - cancellation
  - probe
sources:
  - commit 1dc2af2f263dfaca575e24e7f3f788daace01f5c
  - plan: frozen patch54eed0cadc27af17852783aca0e08d05d86bc420eab3babcb6d9c324b9144636
  - plan: independently reproduced probe defect discovered during R153
repro: Actual Playwright abort-handshake control fails the deadline assertion; owned raw-CDP transport passes the same assertion
status: open
---

## Problem

The stall classifier wraps Playwright attachment and send in asyncio.timeout. However, cancellation enters Channel._inner_send's Connection._abort path, which waits for the same unanswered callback or transport error. The timeout therefore need not return. An actual-SDK offline control with mocked transport demonstrates this defect independently of R153's unknown original nested await.

## Diagnosis

The original classifier's10ms probe remains pending150ms after sending __abort__. A second external cancellation is used only to clean up that failing test, not as a proposed runtime contract. Installed Playwright1.63.0 connection source SHA256 is7a1fe6c84e5108024b58d2afa4f2d8323ca86d76adecde5e8a747c3bab2bd49b; cdp-use1.4.5 client source isbedb06f030c34b825a8ccd11200001ca6eec85af8db317be9446f50ab3d80983. Original guest dependency-byte equality is unclaimed.

The same registered deadline assertion fails on original1dc service code and passes with the candidate. Existing cdp-use response dispatch removes a matching request and ignores an unknown late ID, enabling bounded local ownership without a Playwright abort handshake. Simply abandoning an SDK task would leave attachment/disposal ownership unresolved and is not the repair.

## Solution

Frozen four-path patch54eed0cadc27af17852783aca0e08d05d86bc420eab3babcb6d9c324b9144636 adds OwnedCdpProbe and routes the production classifier through the already attached native client. Only fixed Runtime.evaluate(1+1) and Browser.getVersion reads are sent. Each request owns one monotonically allocated ID/future, shares its existing per-probe budget across send and response, and removes only its own pending entry on completion, timeout or cancellation. No new CDP session, provider connection, detached cleanup task or extra grace is introduced.

Renderer probes require the cached input Page's exact target, native session and current first-context membership. The original socket and pending-map identities are captured at binding and checked before send and after the await. Replaced session/connection/target/Page or missing binding yields error/unknown; it cannot authorize renderer recovery. A send not confirmed complete also remains error. A sent unanswered read preserves the existing timeout classification. Existing2s per-probe budgets and action deadlines remain unchanged.

V1aac519 failed independent review: replacement before the first read could send an old session ID over a new socket. V2 binds the original socket/map and adds unchanged RED/GREEN regressions for both pre-read replacements, both probe kinds, zero sends and unknown classification. Seven registered offline controls pass five same-byte runs; two existing timeout-owner/classification controls pass. Independent C review approves the runtime and fixture changes. The final helper/handler/service SHA256 values are4891ab9c19aa38c0e2f290dc0859e65e88ad225ee008614af781446ab2354044,52f77203908e62545e92ad2b6c2819fe49405be9785e0cf33cbd2f59740cfb48 and1f0e971839f2a97a11b6d3e52a5cbfc32a659db21aaf012ce792dc389ff8b0c6; final test1ca9a1da9d9c9784228cadc02ec8a74e942031f64b984e1897d27c723f5d5d7b.

Three registered real-Chromium controls retain all19 original assertion ASTs and use explicit local CDP transport. The first authorized run passes3 tests but emits four teardown future warnings; its original log is retained. A separately reviewed test-only cleanup removes redundant detach requests after browser closure, asserts pending-map empty and always closes the owned client/context. The second authorized run passes3 tests in20.464648s with no warnings and no remaining observed owned process identities. Its log SHA256 is40a19faf10da1b85312db14e526a0b9614fa99a827dae735c7a89ca89f476017. A's single full registered domain run (session11597, PID3817698) exits0 with954 passed/0 failed in245.453810s on exact1dc plus patch54eed0ca; the parent independently verifies its source bindings and log SHA256615fd1b02fba96ca85b10ae4eec34fc6e02f0916ddbf96d6c9c3b1ed609f92ed. Parent integration remains pending; no production deployment or original benchmark repair is claimed.

Personally opened primary analogs are Hermes agent/lsp/client.py455-488 (exact pending entry cleanup), OpenClaw extension-relay/relay-bridge.ts375-404 (owned request timeout/abort) and Codex core/client.rs1290-1320 (bounded connection future). Their retries and broader lifecycle policies are not imported. R84's earlier shared attachment/send budget remains useful but did not cover the real SDK's abort acknowledgement wait. Unknown bindings must stay unknown, and R153's original post-auth stall remains separately OPEN.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

A timeout is only bounded if cancellation itself is bounded. Prefer an already owned read transport with exact request cleanup and connection identity over spawning an SDK operation whose abort requires the unresponsive peer to acknowledge it.
