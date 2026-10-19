---
id: 2026-10-14-codex-smoke-fixture-not-bound-to-current-local-account
date: 2026-10-14
title: Codex local auth import succeeded but the smoke selected another seeded account
surface: infra
component: codex-blackbox-configuration
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The coverage fixture reused a multi-account identity without binding the smoke to the currently imported local account
symptoms:
  - token_revoked
  - refresh_token_invalidated
  - Codex output did not include CODEX_E2B_DONE
  - codex-code 26 passed, 1 failed, 0 skipped
tags:
  - codex
  - oauth
  - fixture-identity
  - deploy-gate
sources:
  - commit e576489611da771499791db3980d78a1db8c5c02
  - commit a5aaa8fc3b50bbb3b8a2bd024315fb0dbc5ca027
  - task codex_recovery_20261014_201703_83bf30
  - task backend coverage 1792014135-1122715-26840
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts
status: mitigated
---

## Problem

The unchanged e576 backend coverage run failed its real Codex E2B smoke:
26 tests passed, one failed, none skipped (46,708 ms). The retained 5,446-byte
output for session `3fd51655-483e-49f5-b2e3-cc828bd2ed3b` contains OAuth
`token_revoked`, `refresh_token_invalidated` and revoked-refresh prose before
funded-key `no credits remaining`. Replaying that output through the unchanged
classifier returned skip=null; the sentinel assertion correctly failed.
The funding phrase did not justify skipping a separate revoked OAuth path.

## Diagnosis

Coverage did import the October 14 local auth, but selected an older October 7
connected integration for another account. Private decrypted access/refresh
comparisons matched the selected row to production's existing revoked lineage
without printing secrets. Import intentionally preserves other accounts; a
successful import does not prove which account the smoke exercised.
The original coverage used the system-Postgres `victoria` fallback rather than
an explicit uniquely owned coverage DB. This mixed seed identity was the
first bad configuration boundary, not evidence of a new fallback or classifier
code defect. Provider revocation is established by the actual smoke response,
not inferred from token age.

Archive searches for reused/revoked Codex OAuth, token_revoked and current local
auth found the September 27 stale-cloud-auth case and October 1 credit-skip case.
These are relatives, not recurrences: September 27 lacked the current authority
and wrapper selection; here local import succeeded but another account won
selection. The October 1 revocation veto is working. Local fixture recovery required no credential-selection or
credential-ownership implementation change. This does not establish that the
production ownership implementation is correct.

## Solution

Use the existing native sync/runner with a fresh test identity and local DB.
Align CODEX_TOKEN_USER_ID and CODEX_BLACKBOX_USER_ID, explicitly select the
current existing CODEX_AUTH_PATH, disable pooling for this fixture, and keep
BACKEND_CODEX_TOKEN_SYNC_SKIP=0. Preserve unrelated accounts and production
rows. Do not relabel revocation as a funding-only skip.

The unchanged focused command, with the isolated DB/backend identity also set:

```bash
CODEX_TOKEN_USER_ID="$RCA_USER" CODEX_BLACKBOX_USER_ID="$RCA_USER" \
CODEX_AUTH_PATH="$EXISTING_AUTH_FILE" CODEX_TOKEN_POOLING_ENABLED=false \
BACKEND_CODEX_TOKEN_SYNC_SKIP=0 npm run test:blackbox -- codex-code
```

The fresh fixture user was `5e5d14b5-9d72-49f4-abe4-0ee6f4e86f8e`. Its selected
integration `a70da527-80db-4ac8-9a79-5d18afc27bc5` matched current local auth.
The real smoke completed via ChatGPT OAuth and verified completion/output-file
sentinels: 27 passed, 0 failed, 0 skipped (50,803 ms; smoke 34,966 ms).
The initial missing-run-id setup failure and original failed coverage remain
retained; no prompt, evaluator, timeout or skip policy changed.

The authorized a5 backend rerun explicitly used owned local database
victoria_rose-backend-verification-537d914c902b and the same supported fixture
configuration. Canonical coverage passed 266 unit files and 196 blackbox domains,
zero failures, in 778.3 seconds. Coverage: 89.60% statement/line, 81.03% branch,
92.66% functions. Codex again passed 27/0/0 with a real ChatGPT OAuth smoke
(18,409 ms). Normal-exit and SIGTERM backend/port-lock teardown controls passed.
Timing run `20261014-214106-1111770` and native full-suite
run `1792014135-1122715-26840` retain the authoritative result.

Controller evidence: /home/boxes/rose-deploy-auth/.context/codex-recovery-config.json
and .context/test-runs/codex_recovery_20261014_201703_83bf30/; full rerun receipts
are in /home/boxes/rose-backend-verification/.context/backend-verification-scope.json
and back-end/coverage/. This is local fixture mitigation and backend verification,
not final-source auth acceptance or production repair. Existing other-account
production revocation and the original Gmail credential-ownership incident
remain unresolved. No alias or ownership feature was added.

## Human feedback

The user required every standard deploy gate and the complete auth suite,
preserved failed attempts, and prohibited prompt/evaluator/timeout changes to
manufacture passes. The user explicitly separated the original Gmail ownership
incident from this benchmark. No credential-selection policy change was approved
or made to recover the local smoke.

## Reusable lesson

Bind an isolated smoke fixture to the imported account and verify the selected identity before treating a successful credential import as readiness.
