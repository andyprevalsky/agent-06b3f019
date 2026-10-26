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
  - commit cc2fcd368 (versioned codex-code-v0159 default + contract)
  - commit 61774b2c8 (native outputSchema handoff)
  - commit 0fc2ee64c (smoke completes on turn/completed)
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts (BLACKBOX_SMOKE=1) smoke and template cases
status: fixed
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

The shared `codex-code` alias is left untouched, because prod's backend (main) still overlays the 0.144
ws-server onto it. A NEW template `codex-code-v0159` (id vm08m76z4xzp9s91u24x, build
b147d81a-d6bf-48ed-a5b7-563f276c65f6, codex-cli 0.159.0, 2 vCPU / 1024 MB) was built from
this branch's Dockerfile by the new `e2b-templates/build-template-version.mjs`. That script
uses E2B_API_KEY, refuses the shared alias and existing names, and writes a receipt.
`back-end/src/providers/codexTemplate.ts` is the single default used by e2b.ts, sandboxSize.ts
and inspect.ts. Deploying the branch therefore switches Codex sessions atomically with the code
that needs them. The template contract now fails when the code default, the Dockerfile pin and the
versioned alias disagree, or when a provider re-declares a literal default. It was red for both
mutations and green 5x. Render and Fly set no E2B_CODEX_CODE_TEMPLATE_ID.

On the new template a real Codex turn completed but ignored the instruction-only handoff. The
overlay now ports `codex exec --output-schema/--output-last-message`
(codex-rs exec/src/event_processor.rs:33-42): the goal turn sends the handoff schema as a
strict turn/start outputSchema (client_common.rs:52 strict default). Optional fields become
nullable, and those nulls are pruned. The final message is written to /home/user/.rose/handoff.json.
Schemas with open objects, which strict mode cannot express, keep the instruction-only contract.
The smoke helper now ends on turn/completed, the worker's contract, instead of a process exit
that the app-server transport never sends. Real Codex E2B smoke: PASS, with the handoff asserted.

## Human feedback

None recorded.

## Reusable lesson

Version a prebuilt image with the code that targets it (new alias + one code default + a contract test); never rebuild a shared alias that older deploys still resolve.
