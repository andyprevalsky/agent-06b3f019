---
id: 2026-09-27-cloud-codex-gate-missed-explicit-local-auth-and-wrapper-selection
date: 2026-09-27
title: Cloud Codex gate reused stale seeded OAuth and omitted the committed wrapper selection
surface: infra
component: codex-blackbox-configuration
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The cloud blackbox launcher had no current CODEX_AUTH_PATH and the overlay resolver had no explicit E2B_CODEX_CODE_TEMPLATE_ID
symptoms:
  - Your refresh token has already been used to generate a new access token
  - Codex Code ws-server overlay not found; using server bundled in E2B template
  - codex-code real E2B smoke failed without CODEX_E2B_DONE
  - codex-code 23 passed, 1 failed, 0 skipped
tags:
  - codex
  - oauth
  - cloud-setup
  - e2b
sources:
  - PR #1299
  - commit f94858c8316609b2c8e7c94c07f2b74a7672687f
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts
status: mitigated
---

## Problem

The actual r3 backend gate failed the unchanged real Codex E2B smoke at
23:11:21 UTC on September 27. It reported a reused refresh token, HTTP 401,
and no completion sentinel: 23 tests passed, one failed, none skipped.
This preceded the separately investigated PostgreSQL OOM. Deliberate
credential-error tests earlier in the same domain passed and are not this fault.

## Diagnosis

The selected isolated integration was `62f9f6d3-7c42-465e-bba7-517c9e56680d`.
Fresh read-only production and isolated-database queries compared decrypted
credential hashes without logging secrets. Both access and refresh hashes
matched the production CONNECTED integration
`86ae2dc2-fce6-48c2-95a0-53b83bcdceda`, whose access token expired September 18.
The authoritative Mac Codex file held a newer same-account envelope. The cloud
host's default `/.codex/auth.json` was absent, so the existing optional local
sync did not import that authority. Token expiry alone is not provider proof;
the actual E2B refresh rejection supplies that evidence.

A second configuration boundary was visible in the same failed run:
`e2b.ts` defaults sandbox creation to `codex-code`, but
`e2bWsServerOverlay.ts` requires the explicit environment variable to select
the checked-in wrapper. The real log said the overlay was absent. Static tests
of the committed wrapper did not prove those bytes ran in that sandbox.
The bundled wrapper's bytes were not retained, so no specific behavior is
attributed to an unobserved version.

Archive searches for reused/invalid Codex credentials and stale cloud auth
found the July 8 unchanged-upload case and July 13 sandbox fallback case.
They are relatives, not recurrences: this run never exercised the Mac upload
skip condition, and the repair did not change provider fallback policy.

## Solution

Copy the current authoritative auth file through the existing authenticated
file transport into a unique task-owned 0700 directory, with a 0600 file.
Verify its hash immediately before copy/import. Set `CODEX_AUTH_PATH` to that
file and explicitly select `E2B_CODEX_CODE_TEMPLATE_ID=codex-code`, matching
the existing sandbox creation default. The unchanged canonical launcher then
runs its existing `sync-codex-token.ts` against its validated localhost DB.
No production integration or shared credential was written or rotated.

The same `npm run test:blackbox -- codex-code` completed native exit zero in
40.14 seconds: **24 passed, zero failed, zero skipped**. The real smoke reported
ChatGPT OAuth success, not funded-key fallback; its completion/file sentinels
were checked by the unchanged test. Backend logs prove the committed wrapper
was overlaid and the E2B session closed. A fresh read-only query shows the new
selected isolated integration's access/refresh/account hashes match the
private authoritative input. These two configuration changes were applied
together; this is not an auth-only ablation.

Evidence is retained under
`.context/acceptance/proof21-r3-codex-auth-rca/`, particularly
`result-final.json`, the original `comparison.json`, and `after-collected/`.
The original r3 failing log and all negative-control assertions remain intact.
The successful launcher still leaked two local backend descendants; separate
native-identity-checked retirement proved both absent and the listener gone.
That canonical launcher cleanup defect has its own owning-boundary RCA.

The controller-local configuration is repaired. Future normal benchmark
guests still source compute credentials through their canonical production
seed overlay; the local controller import does not propagate to that path.
`guest-credential-route.json` records this separate open configuration
condition. Full backend coverage and the 100-run fleet proof remain pending;
this domain pass supplies no fleet acceptance credit.

## Recurrence — 2026-10-14 deploy validation

The unchanged `e576489611da771499791db3980d78a1db8c5c02` backend coverage run
reported `codex-code` 26 passed, one failed, zero skipped (46,708 ms). The
persisted 5,446-byte smoke output for session
`3fd51655-483e-49f5-b2e3-cc828bd2ed3b` contains `token_revoked`,
`refresh_token_invalidated`, and revoked-refresh prose before the funded-key
`no credits remaining` error. Replaying this output through the unchanged
classifier returned `skip: null`; the October 1 revocation-veto regression is
working. This is not an all-paths funding skip or a new classifier defect.

The original coverage process used the system-Postgres `victoria` fallback.
It imported current October 14 local auth into a new integration, but selected
an older October 7 connected integration belonging to another account. Private
access/refresh comparisons matched that selected row to production's existing
revoked lineage without exposing credential values. Thus the September 27
instruction to import current auth was insufficient in a multi-account seed:
import preserves other accounts, and does not prove which identity the smoke
exercised. No provider fault is inferred from token expiry alone.

Configuration-only recovery used the existing native runner/sync scripts in a
fresh local DB with aligned `CODEX_TOKEN_USER_ID` and
`CODEX_BLACKBOX_USER_ID=5e5d14b5-9d72-49f4-abe4-0ee6f4e86f8e`, explicit current
`CODEX_AUTH_PATH=/home/boxes/.codex/auth.json`,
`CODEX_TOKEN_POOLING_ENABLED=false`, and `BACKEND_CODEX_TOKEN_SYNC_SKIP=0`.
The unchanged `npm run test:blackbox -- codex-code` passed 27 tests, zero
failed, zero skipped (50,803 ms); the real ChatGPT OAuth smoke took 34,966 ms
and verified completion and output-file sentinels. Selected integration
`a70da527-80db-4ac8-9a79-5d18afc27bc5` matched the current local auth. Both
initial setup failure and original coverage failure remain retained.

Safe configuration and native receipts are in the controller's
`.context/codex-recovery-config.json` and
`.context/test-runs/codex_recovery_20261014_201703_83bf30/` under
`/home/boxes/rose-deploy-auth`. The rerun on authorized backend verification
source `a5aaa8fc3b50bbb3b8a2bd024315fb0dbc5ca027` explicitly names its own
`victoria_rose-backend-verification-537d914c902b` coverage DB and carries the
same supported identity configuration. The canonical coverage command passed
266 unit files and all 196 requested blackbox domains, with 89.60% statement
and line, 81.03% branch, and 92.66% function coverage in 778.3 seconds. Its
Codex domain passed 27 tests with zero failures or skips; the actual ChatGPT
OAuth smoke took 18,409 ms. Normal-exit and SIGTERM teardown controls passed.
The timing run is `20261014-214106-1111770`; the full-suite run is
`1792014135-1122715-26840`. This is backend verification only: final runtime
source, all-auth regression, and production deployment remain separate gates.

This remains a controller-local mitigation. Other-account production OAuth
revocation, generic credential ownership, and the original Gmail incident are
not fixed by fixture isolation. No production credential row, prompt,
evaluator, timeout, skip policy, or credential-selection implementation was
changed. Validate the selected account as well as the imported credential,
and use a uniquely owned coverage DB before attributing the failure to source.

## Human feedback

The user required infrastructure-only readiness without changing benchmark
prompts, models, evaluators, task outcomes, or the five-minute task limit.

## Reusable lesson

Bind a cloud credential check to its current authoritative private input and the exact wrapper bytes that the real sandbox executes.
