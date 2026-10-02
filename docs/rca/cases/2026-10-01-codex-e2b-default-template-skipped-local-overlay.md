---
id: 2026-10-01-codex-e2b-default-template-skipped-local-overlay
date: 2026-10-01
title: Default Codex E2B template skipped the local fallback server overlay
surface: back-end
component: e2b-codex-session
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/e2bWsServerOverlay.ts returned null when E2B_CODEX_CODE_TEMPLATE_ID was unset
symptoms:
  - "Codex Code ws-server overlay not found; using server bundled in E2B template"
  - "revoked OAuth sandbox exited without an auth_fallback event despite a funded key being injected"
tags:
  - codex
  - e2b
  - oauth
  - deploy-gate
sources:
  - task Codex blackbox run 1790906763-95585-14978
  - task Codex blackbox run 1790906856-13965-4819
repro: back-end/src/tests/blackbox/codex-code-overlay.case.ts
status: open
---

## Problem

The real Codex E2B smoke failed when an OAuth refresh token was revoked, even though the backend had injected the funded OpenAI key for runtime fallback. The sandbox emitted `turn.failed` and exited without an `auth_fallback` event. The backend log showed `Codex Code ws-server overlay not found; using server bundled in E2B template`.

## Diagnosis

The path was backend credential resolution → E2B sandbox create → local WebSocket server overlay → Codex CLI OAuth error → funded-key fallback. The backend had both `CODEX_AUTH_JSON` and `OPENAI_API_KEY` in the sandbox environment. The local overlay lookup treated `E2B_CODEX_CODE_TEMPLATE_ID` as a local directory name and returned `null` when the environment variable was unset, although `createCodexCodeSession` correctly defaulted the remote template ID to `codex-code`. That left an older bundled server in charge of the sandbox, so the checked-in revoked-token fallback was never executed.

Archive searches for `Codex OAuth refresh token revoked funded key fallback smoke` and `E2B Codex ws-server overlay default template missing` found earlier funded-key fallback cases, but those concerned backend selection or CLI error wording, not the overlay lookup.

## Solution

The overlay now reads the fixed local `e2b-templates/codex-code/ws-server.mjs` path for both default and custom remote template IDs. A blackbox case captures the sandbox file upload and checks that the uploaded content has the OAuth fallback handler. The same focused test failed before the fix with `Codex ws-server fallback source was not overlaid for template <default>` and passed afterward:

```bash
cd back-end && npx tsx -e "import {testCodexWsServerOverlayUsesLocalSource} from './src/tests/blackbox/codex-code-overlay.case'; testCodexWsServerOverlayUsesLocalSource().then(()=>console.log('PASS')).catch(e=>{console.error('FAIL',e.message);process.exitCode=1})"
```

The real revoked-token E2B run reached the funded-key fallback after the overlay fix; that key then returned `no credits remaining`, so the sandbox could not produce the completion marker. A later normal OAuth run passed the real Codex smoke, but it does not prove completion through the funded key. Keep this RCA open until that exact fallback completes with a funded key.

## Human feedback

None recorded.

## Reusable lesson

A remote image identifier is not a source directory. Runtime overlays must resolve local files independently of optional deployment IDs.
