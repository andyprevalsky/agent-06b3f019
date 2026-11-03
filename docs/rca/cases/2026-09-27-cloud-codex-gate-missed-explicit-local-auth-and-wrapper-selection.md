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

## October 6 local continuation

The WMH continuation's backend coverage selected an older connected Codex
integration and the native sandbox reported revoked OAuth. Its funded-key
fallback had no credits. The hard failure classification was retained.
The local database also contained a newly synced integration for another
account, so the default user's accumulated rows were not a deterministic
credential fixture. These observations do not prove a production selection bug.

Use the existing `CODEX_TOKEN_USER_ID` and `CODEX_BLACKBOX_USER_ID` controls with
one task-owned identity and the authoritative local `CODEX_AUTH_PATH`. No old
integration or shared auth file was deleted, replaced, or rotated. The unchanged
`npm run test:blackbox -- codex-code` passed **27 checks, zero failures, zero
skips**, including ChatGPT OAuth sandbox execution and native session cleanup.
The complete backend coverage command subsequently passed all 184 domains and
253 unit files, with 89.23% lines and 80.34% branches, plus both teardown checks.
Evidence is retained in `.context/wmh-codex-isolated-identity.log` and
`.context/wmh-backend-coverage-complete.log`. The private task environment file
is ignored and contains only the scoped identity and auth-file path.

## Human feedback

The user required infrastructure-only readiness without changing benchmark
prompts, models, evaluators, task outcomes, or the five-minute task limit.

## Reusable lesson

Bind a cloud credential check to its current authoritative private input and the exact wrapper bytes that the real sandbox executes.
