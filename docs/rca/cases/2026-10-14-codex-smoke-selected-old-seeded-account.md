---
id: 2026-10-14-codex-smoke-selected-old-seeded-account
date: 2026-10-14
title: Codex smoke selected an old seeded account instead of the current local credential
surface: infra
component: codex-blackbox-configuration
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The default founder fixture contained multiple ChatGPT accounts and least-recently-used credential selection chose an older seeded account rather than the current local authority
symptoms:
  - "Codex output did not include CODEX_E2B_DONE"
  - "401 token_revoked"
  - "refresh_token_invalidated"
  - "You have no credits remaining. Add credits to continue using the API"
  - "codex-code 26 passed, 1 failed, 0 skipped"
tags:
  - codex
  - oauth
  - fixture-identity
  - seeded-account
  - deploy-gate
sources:
  - task deploy run 20261014-231005-489109 backend-coverage-blackbox stage
  - task blackbox run 1792019653-540724-6605
  - task local ClaudeCodeSession 6303ae33-d6ca-4b11-b3fe-a02fad90b1b0
  - task .context/test-runs/backend-coverage-failed-20261014-232329-525786/runner.log
  - task .context/test-runs/1792020736-868664-28621/codex-code.log
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts; explicit CODEX_TOKEN_USER_ID and CODEX_BLACKBOX_USER_ID fixture binding
status: mitigated
---

## Problem

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

## Diagnosis

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

## Solution

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

The complete backend coverage gate must still pass with this explicit fixture
binding before the deployment can proceed. This focused pass is not a full
coverage claim, and the older account's provider authorization remains a
separate state; status stays mitigated pending full-gate verification.

## Human feedback

The user requested deployment of messaging reactions and replies. No credential
skip or gate override was approved. An async reauthentication/override question
was raised before the selected-credential identity was established; it became
unnecessary after the current authority passed and the user was told to ignore
it.

## Reusable lesson

Bind credential smoke tests to their declared local authority before treating a
revoked account chosen from a mixed production seed as proof that the current
login needs reauthentication.
