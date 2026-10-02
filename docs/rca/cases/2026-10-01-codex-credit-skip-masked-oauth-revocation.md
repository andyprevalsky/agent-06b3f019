---
id: 2026-10-01-codex-credit-skip-masked-oauth-revocation
date: 2026-10-01
title: Codex smoke credit skip masked revoked OAuth when the fallback key was empty
surface: back-end
component: codex-blackbox
classification: test-bug
problem_class: other
first_bad_boundary: back-end/src/tests/blackbox/codex-credit-skip.ts treated any funding phrase as proof that every credential path failed from funding
symptoms:
  - "revoked OAuth plus no-credits funded key was reported as an all-paths credit SKIP"
  - "funded-key exhaustion cannot excuse a revoked OAuth credential"
tags:
  - codex
  - oauth
  - credit-skip
  - deploy-gate
sources:
  - task Codex blackbox run 1790906856-13965-4819
  - task Codex credit-skip focused regression
repro: back-end/src/tests/blackbox/codex-credit-skip.case.ts
status: fixed
---

## Problem

With an intentionally invalid OAuth refresh token, the real Codex E2B run used the restored local server and attempted the funded OpenAI key. The key had no credits. The blackbox detector declared `Codex credentials exhausted (out of credits/quota) on all paths` and marked the smoke skipped, even though the OAuth path had failed because its refresh token was revoked. The deploy rule allows a credit skip only when every available path is blocked by funding; revoked OAuth requires reauthentication and must remain a failure.

## Diagnosis

The path was sandbox OAuth error → `auth_fallback` → funded-key credit error → blackbox `codexSmokeCreditSkipReason`. That function checked for any credit phrase in the combined output and events. It did not first exclude the captured OAuth revocation signal. The first bad boundary was the skip classifier, not the sandbox's key fallback.

Archive searches for `Codex OAuth refresh token revoked funded key fallback smoke` and `Codex credit skip masked revoked OAuth` found the earlier credit-skip cases, but their fixtures each contained only one failure class.

## Solution

The classifier now refuses a credit skip when the output or structured events contain an OAuth revocation signal, even if a later funded-key error says `no credits remaining`. The permanent Codex blackbox case uses the captured two-path sequence and a code-only `token_revoked` event. The exact pre-fix command exited 1 with `funded-key exhaustion cannot excuse a revoked OAuth credential`; the unchanged command exited 0 after the fix. The code-only case independently failed before the pattern was extended and passed after:

```bash
cd back-end && npx tsx -e "import {testCodexCreditSkip_authRevocationStillFailsHard} from './src/tests/blackbox/codex-credit-skip.case'; testCodexCreditSkip_authRevocationStillFailsHard(); console.log('PASS')"
```

The full Codex blackbox domain then passed with a usable ChatGPT credential. The intentional revoked-token sandbox remains a hard failure while the fallback key has no credits, as required.

## Human feedback

None recorded.

## Reusable lesson

A skip classifier must classify each credential path's failure cause; one funding error in a multi-path run does not prove all paths are out of funds.
