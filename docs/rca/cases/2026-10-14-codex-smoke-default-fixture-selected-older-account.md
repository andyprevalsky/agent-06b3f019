---
id: 2026-10-14-codex-smoke-default-fixture-selected-older-account
date: 2026-10-14
title: Codex smoke selected an older account despite a fresh local credential
surface: back-end
component: codex-blackbox-fixture
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The default Codex smoke user retained multiple connected accounts, so credential selection consumed the older production lineage rather than the explicitly available fresh local auth source
symptoms:
  - "Codex output did not include CODEX_E2B_DONE. exit=unknown"
  - "refresh_token_invalidated"
  - "token_revoked"
  - "You have no credits remaining. Add credits to continue using the API"
tags:
  - codex
  - oauth
  - fixture-authority
  - deploy-gate
sources:
  - task WhatsApp media RCA deployment backend coverage
  - task backend coverage run 1792015377-10564-17238
  - task local Codex retry run 1792016300-290025-5874
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts
status: mitigated
---

## Problem

The required backend coverage run failed its real Codex E2B smoke while the individual funding-detector cases passed. The displayed tail contained funded-key exhaustion, but the persisted session contained an earlier revoked OAuth credential. The gate was correctly red: the approved funding exception does not excuse OAuth revocation.

The failed coverage artifacts are `.context/test-runs/backend-coverage-failed-20261014-221231-6318/runner.log` and `server.log`. Session `5629827b-c1f3-4e07-8ffd-d8dcab1d2c6c` preserved the complete output in the local database; its credential association identifies integration `933aef3b-5183-4c86-a595-4a2076187496` as the selected source. The successful retry is `.context/test-runs/1792016300-290025-5874/codex-code.log`: line 7 records the real smoke passing in 13,781 ms, and line 88 records 27 passed, 0 failed, 0 skipped.

## Diagnosis

The failing session selected the older account lineage, refreshed on October 7, rather than the local auth file refreshed on October 14 at 18:11 UTC. Read-only inspection of the authoritative production database confirmed that its latest connected credential for the default development user was that older, different account. The local database retained both accounts as connected.

`back-end/scripts/sync-codex-token.ts` deliberately refreshes the selected account while preserving other accounts. `back-end/src/providers/gptCredentials.ts` uses least-recently-used selection across the user's connected rows. Sharing the default smoke identity with multiple account lineages therefore left the live gate free to select the older account. A recent sync timestamp on another row did not bind this invocation to the fresh source.

The captured output includes `token_revoked`, `refresh_token_invalidated`, the explicit refresh-token-revoked error, then funded-key exhaustion. Local replay through the unchanged `codexSmokeCreditSkipReason` produced `oauthRevoked=true`, `fundedExhausted=true`, `success=false`, and `skip=null`; the existing missing-sentinel assertion failed with `Codex output did not include CODEX_E2B_DONE`. The captured output remains at `.context/codex-gate-rca/captured-output.txt`; raw credentials are excluded from the case.

Archive searches were `codex no credits remaining CODEX_E2B_DONE` and `codex funded credential exhaustion smoke skip auth revoked`. The October 1 case `2026-10-01-codex-credit-skip-masked-oauth-revocation` is related: its corrected guard worked here. This is not a recurrence of that detector bug, and weakening it would conceal the credential failure.

## Solution

Follow `CLAUDE.md`'s Test Credentials rule to try the local token before escalation. Bind the canonical Codex smoke and its canonical credential-sync helper to the same dedicated local fixture user. This selects the available local authority without changing production credentials, the account selector, or the funding/auth policy:

```bash
cd /home/boxes/rose/back-end
CODEX_AUTH_PATH=/home/boxes/.codex/auth.json \
CODEX_TOKEN_USER_ID=e84706cd-4aaa-4823-86fe-63e4f7092e53 \
CODEX_BLACKBOX_USER_ID=e84706cd-4aaa-4823-86fe-63e4f7092e53 \
BACKEND_CODEX_TOKEN_SYNC_SKIP=0 \
bash scripts/run-blackbox-tests.sh codex-code
```

The unchanged canonical domain passed: 27 tests passed, none failed or skipped, domain duration 29,821 ms. Its real smoke emitted `CODEX_E2B_DONE` and passed the existing structured-event and output-file assertions. Session `0b363f74-ac9e-4900-bc89-628cc298cbe6` selected fresh integration `b7fd8c88-00bb-49d7-8401-6ea1bf980056`. That session's stored output contains the success sentinel and no OAuth-revocation or funded-exhaustion signal. This proves the tested local source worked for that invocation; it makes no claim about the validity of other production accounts.

The exact environment and result receipts are `.context/codex-gate-rca/fresh-local-fixture-env.json` and `fresh-local-result.json`, both mode 0600. The owned isolated backend and runner retired. The full deploy coverage run reused this fixture binding and passed all 196 domains; Codex passed in 27,751 milliseconds. Its retained log is `.context/deploy-runs/20261014-220120-4186766/logs/backend-coverage-blackbox-20261014-222604-382499.log`. Status remains mitigated because the correction binds the local test authority and makes no claim about the older production account.

A separate inspection found duplicate `waitForCodexOutput` imports and two equivalent implementations. Repository search confirmed the redundant `codex-smoke-output.support.ts` had only that duplicate import as its consumer; TypeScript compilation with identifiers preserved confirmed identical runtime output. Remove the duplicate import and make the old helper entrypoint re-export the canonical `codex-ws-output.support.ts` implementation. This removes duplication while retaining the existing test entrypoint, and is not presented as the cause or cure of the credential failure. Relevant formatting and ESLint checks pass; the next full coverage run owns its runtime verification.

The credential retry adds one isolated fixture identity and one account row per test environment. It introduces no production runtime work, shared agent counters, polling, or scaling changes at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Bind a live credential gate and its seed helper to the same explicit isolated account authority before interpreting a failure from a shared multi-account fixture.
