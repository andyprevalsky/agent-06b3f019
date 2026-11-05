---
id: 2026-11-03-codex-oauth-feedback-vm-missing-event-interface
date: 2026-11-03
title: Codex OAuth feedback VM fixture omitted the server event interface
surface: back-end
component: code-session-direct-chat
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The OAuth replay VM constructed an empty WebSocketServer stub while the real producer now subscribes to its listening event
symptoms:
  - "TypeError: wss.on is not a function"
  - "Codex producer/worker feedback contract failed"
tags:
  - codex
  - oauth
  - vm-fixture
sources:
  - commit 0e1e72e905c1b07658b031c67e3091f345cc5755
  - commit 6e9a67f79300b7a32ddeb343f0cfffe6eca86d09
repro: node --test e2b-templates/codex-code/oauth-feedback.test.mjs
status: fixed
---

## Problem

The full backend coverage run on 0e1e72e905 passed 356 of 357 unit files. The Codex OAuth feedback wrapper failed because all eight existing replay tests threw `TypeError: wss.on is not a function` before their formatter/fallback/worker assertions ran. The same run passed all 241 API domains and its isolated FPS probe. Those passes do not make the failed unit lane green. Original output remains in the deployment artifacts and native failed-coverage snapshot.

## Diagnosis

The incoming owned-port correction legitimately moved server readiness reporting into its listening callback. Both OAuth VM contexts still provided `WebSocketServer: class {}`. The fixture no longer modeled the producer's event-registration interface. This is INTRODUCED by integration of the valid producer change with the older fixture, not a runtime listener defect.

The related archive case `2026-11-03-native-codex-tests-selected-unowned-listen-port` explains the valid production change. It does not authorize reverting real port ownership or weakening the original OAuth assertions.

## Solution

Supply Node's native EventEmitter to both VM contexts. This registers callbacks without opening a socket; it does not synthesize a listening event. Keep production source, all eight tests and assertions, worker extraction, fallback classification, registration and deadlines unchanged.

The private same-owner control failed eight of eight tests before and passed eight of eight after, with zero skips. Patch SHA256 5255647b6404e813673bfd1440616d0769cb13edbca704b62685af6d12e86eb9. Applied after every original G3 lane ended. The actual registered backend wrapper then passed all eight tests with zero skips; full release validation remains pending in the stabilization batch.

## Human feedback

The user required the complete deployment and fixes for blocking issues. Preserve the original failure, all OAuth assertions, production listener behavior, credentials, leases and Freedom; do not skip this failed test.

## Reusable lesson

When the production code adds an event subscription, update test doubles to expose that event interface rather than removing the production behavior or bypassing assertions.
