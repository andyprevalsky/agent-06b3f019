---
id: 2026-10-15-codex-balance-wording-missed-funded-cooldown
date: 2026-10-15
title: Codex API balance wording bypassed funded credential cooldown
surface: back-end
component: codex-code
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: detectAndMarkCodexExhaustion omitted explicit OpenAI API balance exhaustion wording in terminal snapshots
symptoms:
  - "stream disconnected before completion: You have no credits remaining."
  - "observed no-credits API response must cool the funded key"
tags:
  - codex
  - cooldown
  - credit-skip
sources:
  - commit 6c6e982741bbdb7d122c50f6107a0659093c538e
  - task .context/test-runs/backend-coverage-failed-20261015-024438-64405
repro: back-end/src/tests/blackbox/codex-code-oauth-feedback.case.ts
status: fixed
---

## Problem

The reported smoke failed after OAuth revocation followed by API balance exhaustion. Original server evidence identified session 0e3a0fd3-7904-48ea-ac09-18910d31b886 and sandbox ixdjycv4hqi8gkfhrqgwe. A read-only query of local victoria preserved its complete output in .context/codex-funding-rca/original-session-output.txt. OAuth returned token_revoked and refresh_token_invalidated before the fallback API returned no credits remaining. Rejecting a funding skip was correct: not every path failed from funding. Separately, the backend failed to cool the exhausted funded key because its snapshot detector did not recognize that API wording.

## Diagnosis

Path: sandbox output → smoke output POST → persistOutput → detectAndMarkCodexExhaustion → shared funded-key cooldown. The backend's funding regex diverged from the blackbox detector. The original server log records persistence of 5446 bytes without a cooldown write. This is a relative of the credit-skip/auth-revocation case, not permission to remove its exclusion.

Archive searches: `no credits remaining` and `codex funding cooldown skip`. Read the October 1 credit-skip revocation case: mixed auth and funding failures must remain hard failures. No prompts, schemas, production auth, fallback selection, timeouts, or skip conditions changed. Golden references: codex/codex-rs/codex-api/src/api_bridge.rs:221 classifies insufficient_quota as billing; claude-code-src/src/services/api/errors.ts:774 recognizes low credit balance; hermes-agent/agent/error_classifier.py:131 separates billing signals. Searched openclaw/src for insufficient_quota and credit balance; no same state-persistence boundary found. The fix converges on explicit billing classification while retaining Rose-owned credential attribution.

## Solution

Recognize explicit OpenAI balance exhaustion prose and structured balance-code wording in the existing backend detector. Preserve credential segment attribution. The permanent existing codex-code domain now invokes a local persistence regression that also confirms funded-only exhaustion can skip and revocation plus exhaustion cannot.

Exact owning reproduction, from back-end:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria node --import tsx -e "require('dotenv').config({quiet:true}); require('./src/tests/blackbox/codex-code-oauth-feedback.case').testPersistOutput_coolsFundedKeyForObservedBalanceError().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
```

Before fix: exit 1, ASSERTION FAILED: observed no-credits API response must cool the funded key. After fix, identical command: exit 0. Logs preserved in .context/codex-funding-rca/repro-before.log and repro-after.log.

Live command: `CONDUCTOR_PORT=3581 bash back-end/scripts/run-blackbox-tests.sh codex-code`. Baseline run passed (40805ms), so the original mixed credential failure was not reproduced by the newly synced local credential. This does not establish that the original credential recovered. Parent owns deploy and full gates.

## Human feedback

Standing deployment rules allow skipping only when all available paths fail from funding and prohibit treating auth revocation as exhaustion. Keep all database operations local and preserve original artifacts.

## Reusable lesson

A final credit error does not describe every credential path. Inspect the full native sequence, preserve auth failures, and keep funding feedback vocabulary consistent with provider responses.

Verification: ESLint on all three edited TypeScript files exited 0; `cd back-end && npx tsc --noEmit` exited 0. `python3 scripts/rca_archive.py validate` exited 0. Full post-fix owning domain exited 1: 27 passed, 1 failed, 0 skipped. The new balance regression passed (33ms). The real smoke reproduced the original OAuth revocation followed by API exhaustion, while backend.log now records funded API key backoff for session bcbbbe0d-24cc-4685-bef1-dcaed6a7bca9. Full native output is preserved at .context/codex-funding-rca/post-fix-session-output.txt; native runner artifacts remain in .context/test-runs/1792032512-362481-12124. Original artifacts were not modified. Thus the cooldown defect is fixed, but the mixed credential smoke remains correctly blocked; a valid/re-authenticated OAuth credential or replenished API credits is required. Do not claim a fully passing Codex gate or broaden the skip. The initial baseline live pass shows credential selection/state variability, not recovery of the original invalidated token.
