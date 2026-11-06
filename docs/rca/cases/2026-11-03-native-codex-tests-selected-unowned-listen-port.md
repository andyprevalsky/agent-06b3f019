---
id: 2026-11-03-native-codex-tests-selected-unowned-listen-port
date: 2026-11-03
title: Native Codex app-server tests selected an unowned random listen port
surface: agents
component: code-session-direct-chat
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: app-server.test.mjs selected a random positive PORT without exclusive socket ownership before the production ws-server bound it
symptoms:
  - "Error: listen EADDRINUSE: address already in use :::47472"
  - "production default app-server supports authenticated attachments, steer and cursor replay"
  - "test_codex_native_app_server_contract"
  - "expected: 1 actual: 3"
tags:
  - codex
  - app-server
  - port-ownership
  - eaddrinuse
  - native-process
sources:
  - commit 5b4c8d612a02585ee3e27ec398ddecd27db1e42f
  - commit 062d536ebe703645e3cebaa2a1c027f0c3e1361c
  - agent 01a19fe7-085d-79d1-8e93-36137ded57f6
repro: e2b-templates/codex-code/app-server.test.mjs native app-server contract owns its port while a candidate is occupied
status: fixed
---

## Problem

The original full command was `cd agents && AGENTS_COVERAGE_CONCURRENCY=2 bash scripts/run-coverage.sh`, with managed complete environment, activated agents/venv, TMPDIR=/var/tmp and CODEX_AUTH_PATH absent process-locally. On the failed source, 123 of 124 native domains passed. The existing code-session-direct-chat case failed through its Python native-child return-code assertion. Native output at 2026-11-03T04:37:13.836Z claimed `Server listening` on 47472 immediately before Node failed at ws-server.mjs:197 with EADDRINUSE. The websocket assertion expected readyState 1 and observed 3. Native set-e prevented downstream DEMO, unit and threshold execution; none receives passing credit on that attempt.

The historical competing socket inode and PID were not captured and remain UNKNOWN. A later clean full run on source equivalent to the originating merge passed; that control neither identifies the historical holder nor repairs unowned port selection. Chromium WebAuthn/startup repairs belong to the originating change and remain untouched.

## Diagnosis

Critical path: Python owning blackbox case → native Node suite → random `43000 + floor(random * 10000)` candidate → spawned production ws-server → WebSocketServer.listen → client handshake → existing authentication/attachment/steer/replay assertions. The first violated invariant is treating a random number as exclusive ownership; a free-port probe released before spawn has the same gap. A second native test used the same allocation pattern. The server also logged the requested port before its listening event, so that line could not prove successful binding.

Archive searches were `EADDRINUSE ws-server` and `native app server random port contention`. The deploy-worktree kernel-ephemeral-range case is a relative, not a recurrence: it changes a fixed-range deployment allocator; these native processes can directly request kernel port zero. No historical owner or kernel-autobind cause is inferred here. No completed plan mentioning these exact Codex files was found.

The permanent added test holds an actual dual-stack TCP listener in the old candidate range and pins Math.random only in a nested invocation of the exact existing native case. The competitor rejects handshakes promptly while retaining its listening socket. The native production ws-server, websocket client and original CLI fixture still execute; no protocol reply replaces their behavior. The final unchanged regression failed on the old port-selection/listen code with EADDRINUSE and readyState 3, exit 1; it passed with the fix, exit 0. Private original logs and final RED/GREEN logs are retained in the repair devbox's .context/native-app-server-rca. The final regression body hash is 0e7b2a675ac0d040ffb86dc0f839e5e981308f0476ba6bb4fb50e1aff43875ca.

Gate: NOT_INTRODUCED relative to the originating Chromium fixture/docs/review configuration repair, whose retained source packet establishes the same native allocation code. This classification does not waive this assigned repair or its full-command/deployment obligations.

## Solution

Delete random selection in both native Codex process tests. Pass PORT=0, retain the kernel-assigned listener for the child lifetime, and discover its actual port from that child's own stdout. Publish `Server listening` only from the production WebSocketServer listening event using wss.address().port, matching the existing Claude native pattern. Fixed production ports retain their normal bind behavior; no occupied listener is killed, reused or bypassed. Existing timeouts and authenticated attachment, steer, deduplication, cursor replay and funded-provider assertions are preserved.

The added regression is inside the existing app-server.test.mjs suite, discovered by test_codex_native_app_server_contract in the registered code-session-direct-chat domain. Full agents coverage executes it without an added suite or catalog filter. The original full command and unchanged configured threshold remain separate required release proof, not implied by the focused causal pass.

Simplification removes the allocation race instead of adding locks, port scans or bind retries. Sibling native funded-fallback tests receive the same ownership correction. At 10,000 agents, each server still holds one OS-owned socket; there is no shared application allocator, cross-agent lock or added hot-path work. Golden reference: not applicable (no approval-gated hunk); existing Claude native tests supply the repository pattern.

## Human feedback

The user required ownership of this exact retained native failure through genuine unchanged owning RED/GREEN, the complete current canonical coverage command, ordinary review/merge/production verification, exact cleanup and a completed READY TO CLOSE deploy scorecard. Preserve assertions, timeouts, real processes, complete managed environment, credentials, Freedom and protected instructions. Never attribute the original competing socket to a later observation or count a later clean control as the repair. Do not duplicate the shipped Chromium repair or unrelated provider/empty-output work.

## Reusable lesson

Let the native listener exclusively bind port zero and report its actual address after listening instead of treating a random candidate or released probe as port ownership.
