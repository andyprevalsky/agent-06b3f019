---
id: 2026-07-14-node-20-runner-lacks-native-websocket-for-supabase-client
date: 2026-07-14
title: The semantic gate died before any test because realtime-js now throws (not warns) on a Node 20 runner with no native WebSocket
surface: infra
component: semantic-deploy-gate
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: .github/workflows/chat-lifecycle-ratchet.yml — setup-node pinned Node 20, whose globalThis has no WebSocket for the Supabase client
symptoms:
  - "Node.js 20 detected without native WebSocket support"
  - chat-lifecycle-ratchet fails on main during "Generating shared semantic test session"
  - gate exits 1 before any chat test runs
tags:
  - github-actions
  - node-20
  - websocket
  - supabase-realtime
  - semantic-gate
sources:
  - PR #774
repro: none-recorded
status: fixed
---

## Problem

The production semantic front-end gate (`chat-lifecycle-ratchet.yml`) failed on
`main` immediately during the "Generating shared semantic test session" step
with `Node.js 20 detected without native WebSocket support` and exit code 1 —
before a single chat test executed. Every run of the gate was red while the
product itself was healthy.

## Diagnosis

`back-end/scripts/generate-test-session.ts` constructs a Supabase client, which
constructs a realtime client. A recent `@supabase/realtime-js` changed the
missing-WebSocket condition from a warning to a **throw**, and the GitHub runner's
Node 20 has no native `globalThis.WebSocket`. So a dependency behavior change
turned a previously tolerable environment gap into a hard startup failure. The
first bad boundary is the workflow's pinned runtime, not the script: the same code
runs fine on any Node with native WebSocket. This was a harness/runtime
incompatibility, not a product regression — confirmed by the already-validated
chat changes from #766 (cloud smoke 7/7 on the merged SHA, local semantic 10/10
with all four lifecycle paths under 2.3s p50, prod backend functional health
13/13, clean prod logs).

## Solution

Bumped both `setup-node` blocks in the gate workflow from Node 20 to Node 22,
which has native WebSocket. No application runtime changed, and Node 20 is being
deprecated on GitHub runners anyway, so this removes a whole class of future
polyfill-dependent failures. Being a `.github/workflows/**`-only change, smoke was
safe to skip per deploy policy; the gate was re-dispatched post-merge and required
to pass.

## Human feedback

None recorded.

## Reusable lesson

When a CI gate dies during setup rather than during a test, compare the runner's
runtime capabilities against the dependency's current requirements before hunting
for a product regression.
