---
id: 2026-10-24-codex-ws-server-overlay-outran-deployed-cli-version
date: 2026-10-24
title: Overlaid Codex ws-server (app-server protocol for 0.159) ran against the deployed 0.144.1 CLI and never started a turn
surface: infra
component: e2b codex-code template / E2bWsOverlay
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: e2b-templates/codex-code — commit cf7ada83b bumped ARG CODEX_VERSION to 0.159.0 and rewrote ws-server.mjs for that app-server protocol, but the published codex-code template still ships codex-cli 0.144.1; the backend overlays the new ws-server onto the old CLI
symptoms:
  - "smoke -- Codex completes task in real E2B sandbox -- Timed out waiting for Codex smoke. connected=true, exit=false, output="
  - "template -- pins GPT-5.6-compatible Codex CLI -- ASSERTION FAILED: Codex E2B template must pin the GPT-5.6-compatible Codex CLI and use reliable Ubuntu sources"
  - /tmp/codex-ws-server.log stops after "Client connected"; `codex --version` in the sandbox prints codex-cli 0.144.1
tags:
  - codex
  - e2b-template
  - version-skew
sources:
  - commit cf7ada83b
  - task codex-code blackbox run 1792861461-3767703-5065 (sandbox i2byq8pckjxtjt2lkmq0o retained paused)
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts (BLACKBOX_SMOKE=1) smoke and template cases
status: open
---

## Problem

On feat/rose-user-ui at 7a9994366+75743b45a, the real Codex E2B smoke timed out after
246 s. It was connected but produced no output. The static template-pin case also failed.

## Diagnosis

The sandbox evidence (Sandbox.connect on the retained, paused sandbox) shows:
- The ws-server log has "Server listening", "Wrote Codex ChatGPT auth envelope", "Client connected", and nothing else.
- `codex app-server` is running.
- `codex --version` is 0.144.1.

The repo Dockerfile pins 0.159.0 (cf7ada83b), and the overlaid ws-server.mjs speaks
that version's app-server protocol (thread/start serviceTier, model/list effort/speed).
The contract test still pins 0.144.1. The published template was never rebuilt, so
the code and the image disagree. The handoff contract is not involved, because no turn
ever started.

## Solution

Not fixed. The fix is to rebuild and publish the codex-code templates (all sizes via
build-sized-templates.mjs) from the 0.159.0 Dockerfile and update the template-pin
assertion to 0.159.0. Those template names are shared with production, so publishing
needs the deploy coordinator's go. Then rerun the Codex smoke, which now also asserts
the handoff.

## Human feedback

None recorded.

## Reusable lesson

When a runtime overlay ships newer code onto a prebuilt image, pin and check the image's binary version at session start so skew fails loudly instead of hanging silently.
