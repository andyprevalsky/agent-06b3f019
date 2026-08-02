---
id: 2026-07-27-gpt-credential-sync-had-no-oauth-login-path
date: 2026-07-27
title: '"Connect ChatGPT" only read ~/.codex/auth.json and never drove a login, so it dead-ended for anyone not already logged in by hand'
surface: mac-app
component: gpt-credential-sync
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: mac-app gpt-credential-sync — reads and reports on ~/.codex/auth.json with no install/login counterpart to the Claude flow
symptoms:
  - '"Codex is not logged in with a ChatGPT account" with no way forward'
  - '~/.codex/auth.json holds {"auth_mode":"apikey"}'
  - every codex invocation dies with ENOENT when the npm shim outlives its vendored binary
tags:
  - mac-app
  - codex
  - oauth
  - credential-sync
  - onboarding
sources:
  - commit 88d0c0246
repro: none-recorded
status: fixed
---

## Problem

Connecting Codex from the mac app failed with "Codex is not logged in with a
ChatGPT account" and offered no way forward. The message was accurate —
`~/.codex/auth.json` held `{"auth_mode":"apikey"}` — but the button was a
guaranteed dead end whenever the user had not already logged in by hand in
Terminal.

## Diagnosis

`gpt-credential-sync` only ever **read** `~/.codex/auth.json` and reported on it.
Its Claude counterpart installs the CLI and drives OAuth (`installClaudeCLI` +
`runClaudeSetupToken`); the GPT domain had no equivalent, so the two credential
domains were asymmetric and the GPT one had no path from "not logged in" to
"logged in". Compounding it, telling the user to "go run codex login" is also not
always available: the npm shim can survive while its vendored platform binary is
gone, so every `codex` invocation dies with `ENOENT`.

## Solution

Mirror the Claude flow in `gpt-credential-sync`: probe `codex --version` (catches
both missing and broken-vendor installs), `npm install -g --force @openai/codex`
when unusable, back up any existing `auth.json` to `auth.json.<mode>.bak` because
`codex login` overwrites it wholesale and would destroy an API-key setup, run
`codex login` (ChatGPT OAuth — deliberately **not** `--with-api-key`, which yields
an envelope the backend cannot use), then re-read, validate and upload. Progress
streams to the renderer over a new `gpt:setupStatus` channel. The periodic
background refresh stays strictly non-interactive, asserted by a test that it never
spawns a login.

Debt cleaned in the touched files: the duplicated `getAugmentedEnv` PATH discovery
was lifted into `main/base/shellEnv.ts` so both credential domains share one
implementation. mac-app 1157/1157, structural clean, tsc/eslint/prettier clean.

## Human feedback

None recorded.

## Reusable lesson

When one credential domain can install its CLI and drive OAuth, every sibling
domain must too — a connect button that only _reads_ a credential file is a dead
end for every user who has not already provisioned it by hand.
