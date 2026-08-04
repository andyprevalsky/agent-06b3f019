---
id: 2026-07-15-codex-token-sync-exit-aborts-entire-blackbox-runner
date: 2026-07-15
title: A single credential-sync `process.exit(1)` under `set -e` aborted the whole blackbox runner before any domain ran
surface: back-end
component: blackbox-runner
classification: configuration-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/sync-codex-token.ts — throws when ~/.codex/auth.json auth_mode !== 'chatgpt', exiting 1 under run-blackbox-tests.sh's set -e
symptoms:
  - 'blackbox runner aborts at "Syncing local Codex credentials"'
  - zero test domains execute, no per-domain results printed
  - "~/.codex/auth.json has auth_mode 'apikey' instead of 'chatgpt'"
tags:
  - codex
  - blackbox
  - deploy-gate
  - shared-global-state
  - set-e
sources:
  - memory:project_admin_health_github_codex_env_gotchas
repro: none-recorded
status: fixed
---

## Problem

During the AgentCard payment `/deploy` (2026-07-15) the blackbox suite died at
the very first step, "Syncing local Codex credentials", before a single test
domain ran — so the whole deploy gate produced no signal at all, not even for
domains unrelated to Codex.

## Diagnosis

`back-end/scripts/sync-codex-token.ts` reads `~/.codex/auth.json` and requires
`auth_mode === 'chatgpt'`, otherwise it throws → `process.exit(1)`. Because
`run-blackbox-tests.sh` runs under `set -e`, that non-zero exit terminated the
entire runner up front.

The credential itself broke because `~/.codex/auth.json` is a **shared global
file** across all workspaces: another workspace ran `codex login --api-key`,
which clobbered the file to `apikey` mode. So an unrelated workspace's login
silently disabled every blackbox domain in this one.

The deeper owned defect is the harness contract: a per-domain credential
prerequisite was wired as a fatal precondition for the whole suite, so one
optional integration's credential state gates all unrelated coverage.

## Solution

Restore chatgpt-mode auth by decrypting prod's stored `gpt_code` Integration
`config.encryptedCredentials` and writing the plaintext `auth.json` back. The
envelope is RSA-OAEP-SHA256 wrapping an AES-256-GCM key:
`{version, encrypted_aes_key, iv, ciphertext (= ct + 16B tag)}`, base64-of-JSON,
unwrapped with `CLAUDE_CREDENTIAL_DECRYPTION_KEY`.

Escape hatch when only a single non-Codex domain is needed:
`BACKEND_CODEX_TOKEN_SYNC_SKIP=1`. The runner already blanks
`FAST_MODE_CODEX_PROXY_URL`, so the E2B smoke path is unaffected.

## Human feedback

None recorded.

## Reusable lesson

When a test runner produces zero domain results, suspect a pre-flight credential
step exiting non-zero under `set -e` — and never let one integration's credential
state gate unrelated domains.
