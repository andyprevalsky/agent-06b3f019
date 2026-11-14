---
id: 2026-10-31-playwright-client-not-rebound-after-cdp-reconnect
date: 2026-10-31
title: Playwright input retained a closed client after native browser reconnect
surface: agents
component: browser-client-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: ordinary browser step reused disconnected Playwright browser and input page after the shared CDP connection closed
symptoms:
  - native browser-use reconnect succeeds while Playwright context remains closed
  - optional realm preparation reports Playwright context unavailable
  - later input and screenshot operations retain closed Playwright objects
tags:
  - cdp
  - playwright
  - reconnect
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - agent 2fed1853-5305-461a-846a-ba2fc475391b
  - plan: original run d7937a2f5e9e9259b6d747e3dc3db95b6568afd9e2323c108136fcb3e9936f2c
repro: registered disconnected_playwright_full_activity plus lifecycle and refusal controls
status: open
---

## Problem

It33 r002-j0011 task polar-odysseys-0106b570440f ran on715/patchnone and ended nativeFAILED/progress1 after3089.1s. The two captured completion verifiers returned false/0.5. Original outcome and cleanup axes are preserved; this repair does not establish task success.

## Diagnosis

All seven original normal files and59 embedded payloads verified. The shared CDP socket closed at04:50:29.220089; browser-use reconnected at04:50:35.160522. The later native action classifier reported closed Playwright browser/context objects at04:56:11.689853 and05:02:44.513755. At05:05:53.159070 realm preparation reported Playwright context unavailable. Subsequent native browser-use actions still succeeded. Two later disconnects also reconnected. The final90.5s event-loop stall and activity deadline are separate evidence; the awaited foreground stack is absent, so stale Playwright alone is not assigned as the terminal cause.

The exact715 multiplexer closes both downstream clients when its upstream closes. Browser-use reconnects itself; Playwright retains a disconnected Browser and closed Page. The ordinary tab synchronization returns the current Page when contexts are unavailable, and the input runtime retains the old humanizer. Existing explicit session-rotation logic rebuilds clients, but this ordinary same-session disconnect does not enter that path.

The matched first-run PASS uses the same source and task, runSHAbee5b1043c546433e2f154eca19845ff83f68382d2f9be26f917e7d9ecd65b88. All seven files verify. It too reconnects and later reports unavailable Playwright contexts. This is strong contrary evidence to claiming the stale client alone explains the failed task.

## Solution

Unapplied candidate388817c45fab59184f6a17d2b764f83de3673dec21e47f9126eacc442ad55807 on d2e68c4ea7b546bc17ce6831f71d3e454134ec4f unifies initial and renewed Playwright client setup. Only an explicit disconnected SDK state triggers one attachment to the current DOMService endpoint. It retires the disconnected old local driver before creating a new client, reuses cache/diagnostic/fingerprint configuration, and rebinds input/recording. It validates client/page liveness again after awaited focus and humanizer work. The retired client is not allowed to close the remote browser. The current DOM service, task/session, privacy and credential state remain owned in place. Missing endpoint, failed/empty/cancelled setup or a client closing during setup cannot dispatch stale input. No provider session creation, retry loop, timeout increase, budget change or verifier change is included.

The actual multiplexer-close and full-activity reproduction fails on unchanged d2e because the next action gets the closed Page; the unchanged registered test passes with the candidate. Thirteen compatibility/refusal scenarios supplement it, including an independently reproduced handoff race, late focus/humanizer disconnects and cancellation during old-driver retirement. Existing focus, keyboard, policy, resume, drain, finalizer and setup-failure controls pass. V1 independent review caught a late-disconnect and cleanup-ordering gap; V2 addresses it and passes the unchanged independent reproduction. Independent reviewer B qualified exact388817c45fab59184f6a17d2b764f83de3673dec21e47f9126eacc442ad55807 after independently running20 registered controls and the unchanged late-disconnect reproduction. The author recorded five consecutive same-byte new-regression runs plus16 combined and five foreground diagnostic controls. Integration remains coordinator-owned and pending; the exact patch and frozen tests are held in the private review packet. The original benchmark result remains OPEN and has not been rerun or regraded.

Delete/unify: removing Playwright would remove required input/credential/recording behavior; invoking full provider rotation would replace more owned state than the failed client. Sharing the initial client constructor and configuration repairs the lifecycle mismatch without adding error-string families. OpenClaw invalidates the exact cached browser on disconnection; Hermes resets connection-scoped IDs before attaching again; Codex rebuilds a failed transport from its existing recipe under the original deadline. Those are scoped analogs, not live proof for this task.

Two archive searches covered Playwright/TargetClosedError and CDP/reconnect/stale-browser. The July2 connection-scoped init-script case and October20 remote viewport case were read including their Solution and Human feedback. This change retains existing remote attachment geometry and repeats the same client configuration; it does not claim to repair the earlier viewport or transport-root-cause cases.

## Human feedback

The user prioritizes native failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

A successful reconnect by one browser client does not refresh another client's closed objects. Reattach the failed local client through its existing configuration contract, while preserving the remote session and distinguishing that repair from the task's terminal cause.
