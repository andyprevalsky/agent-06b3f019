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
  - task messaging deploy run 20261014-231005-489109
  - task local ClaudeCodeSession 6303ae33-d6ca-4b11-b3fe-a02fad90b1b0
  - task .context/deploy-backend-coverage-r3.log
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


## Concurrent messaging deployment verification

Consolidated the independently written `2026-10-14-codex-smoke-selected-old-seeded-account` case after main sync exposed the same selected account and fixture boundary. Its full local evidence follows; the companion permanent credential-feedback repair remains a separate product defect.

### Problem

The local backend coverage gate exited 1: 194 API domains passed and two failed.
The independent Rose native-schema failure has its own existing case. The Codex
real E2B smoke created a sandbox but its ChatGPT OAuth request returned
`token_revoked` and `refresh_token_invalidated`. Its existing funded OpenAI
fallback then reported `no credits remaining`. The registered smoke correctly
failed without its completion sentinel; it was not an all-funding skip.

The failed coverage command was the unchanged `npm run test:coverage`, launched
with the documented four blackbox and four unit workers. Its original artifacts
are retained under
`.context/test-runs/backend-coverage-failed-20261014-232329-525786/`.

### Diagnosis

Path: canonical local credential sync -> default founder fixture with several
ChatGPT accounts -> `fetchGptCodeCredentialsWithMeta` least-recently-used
selection -> older seeded account -> provider revocation -> funded-key
exhaustion -> strict smoke failure.

The exact failed session `6303ae33-d6ca-4b11-b3fe-a02fad90b1b0` selected integration
`933aef3b-5183-4c86-a595-4a2076187496`, whose last successful sync was October 8.
Its account differs from the account imported from the current local auth file.
The current import was integration `a74f080d-b87a-4ab2-a8c6-c13579e7f5f8`, synced
on October 14. The native sandbox was `ivlwqv12potgprm1p6qut`; its session is
CLOSED. Its captured output is 5,805 characters / 5,807 UTF-8 bytes and contains
revocation before funding exhaustion, with no `CODEX_E2B_DONE`.

`sync-codex-token.ts` deliberately retires superseded copies of the same account
and legacy empty-account rows, preserving other accounts. `gptCredentials.ts`
selects eligible user integrations by least-recently-used order. Importing a
fresh credential therefore did not bind the founder smoke to that authority.
File presence and nominal expiry alone did not establish authorization; the
successful real sandbox run below did.

Archive searches used `Codex no credits remaining smoke` and
`funded key OAuth revoked exhaustion skip`. The September 27 authoritative-auth
configuration case is a relative; this host had an auth file and the committed
wrapper was overlaid. The October 1 credit-mask bug is not recurring:
`codexSmokeCreditSkipReason` correctly refused to hide revoked OAuth behind a
later funding error. The existing mixed-revocation/funding regression and a
safe local replay both returned no skip. Tokens, encrypted envelopes, and
private account claims were not printed.

### Solution

Use the supported fixture configuration to bind the real Codex smoke to an
isolated UUID user containing only the current local authority:

```bash
export CODEX_TOKEN_USER_ID=<isolated UUID>
export CODEX_BLACKBOX_USER_ID="$CODEX_TOKEN_USER_ID"
export CODEX_AUTH_PATH=/home/boxes/.codex/auth.json
cd back-end
bash scripts/run-blackbox-tests.sh codex-code
```

The canonical runner still syncs and encrypts the real credential, creates a
real E2B sandbox, executes the unchanged task, checks the actual completion and
output-file sentinels, and closes the sandbox. No credential or API fallback
policy, assertion, timeout, classifier, or product integration was changed.
The UUID is stored privately in `.context/deploy-codex-auth.env` for this deploy.
Production and other accounts are untouched.

The corrected fixture completed at
`.context/test-runs/1792020736-868664-28621/`: **27 passed, 0 failed, 0 skipped**;
the domain took 34.674 seconds. This proves the current authority can serve the
real smoke, without reauthentication or a gate override. An intermediate trial
used a non-UUID fixture ID and was rejected by request validation before sandbox
creation; its artifacts remain under `1792020689-860427-28505` and prove no
provider outcome.

The complete backend coverage gate subsequently passed with this explicit
fixture binding: 197/197 API domains, all 270 unit files, 89.61% line coverage,
and both normal-exit and SIGTERM backend retirement checks. Durable stage output
is `.context/deploy-backend-coverage-r3.log`. The older account's provider
authorization remains separate; its observed revocation feedback is repaired
and covered by the companion permanent-revocation case. Remaining deployment
lanes are tracked by the deploy run, rather than by this fixture repair.

### Human feedback

The user requested deployment of messaging reactions and replies. No credential
skip or gate override was approved. An async reauthentication/override question
was raised before the selected-credential identity was established; it became
unnecessary after the current authority passed and the user was told to ignore
it.

### Reusable lesson

Bind credential smoke tests to their declared local authority before treating a
revoked account chosen from a mixed production seed as proof that the current
login needs reauthentication.
