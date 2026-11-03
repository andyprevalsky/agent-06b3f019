---
id: 2026-10-27-gmail-progress-fixture-scanned-foreign-integrations
date: 2026-10-27
title: Gmail progress fixture changed the account-delete fixture through a global sync scan
surface: infra
component: backend-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: integration-accounts.pipelines.cases.ts invoked the global Gmail scheduler on a database shared with foreign domain fixtures
symptoms:
  - DELETE Gmail account returned 200 and the remaining email correctly, then the persisted integration was no longer CONNECTED
  - integrations had 274 passes and one failure in the full 228-domain coverage run
  - integrations alone had 275 passes and zero failures under native coverage
tags:
  - gmail
  - fixture-ownership
  - blackbox
  - cross-domain
sources:
  - plan:.context/deploy-fresh-20261027/rca-gmail-delete/RESULT.txt
repro: bash .context/deploy-fresh-20261027/rca-gmail-delete/run-control.sh
status: open
---

## Problem

At source 46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277, the original full backend coverage run failed the unchanged account-delete assertion in integrations.email-credentials-2.cases.ts:228. The DELETE request returned 200; its remaining-email assertion passed. The later persisted status assertion failed. This cause is separate from the project-workspace fetch failure, owned by the coordinator.

## Diagnosis

The exact test user b8b6175d-7295-47c6-9f6d-5bbaa1b78787 appears in both original domain logs. The integration was created at 01:59:37.523. DELETE updated the Integration at 01:59:38.726 and returned 200 at 38.727. The second integration-accounts scheduler invocation started at 38.322 and selected 190 integrations at 38.339. It wrote the foreign row SYNCING at 38.814, started its credential at 38.827, marked it needs_reconnect at 38.843, and updated the integration status at 38.879. The test's Gmail credentials intentionally omit scopes; the native scheduler correctly rejects them as incomplete sync credentials. The scheduler's test caller, however, did not own those rows. The preceding first scheduler selected 181 integrations; it is not the invocation that captured the newly created DELETE fixture.

First bad ownership boundary: the test caller invokes runGmailSyncJob() with an unrestricted shared database candidate scan. Downstream status changes are consequences. The backend cron was disabled by DISABLE_GMAIL_SYNC; these calls came directly from the sibling test process. This is direct data interference, with no load or deadline hypothesis.

The controlled native reproduction invokes the original DELETE test body unchanged and triggers the actual sibling Gmail pipeline immediately after DELETE, at the existing purge read. On original test code, the native snapshot changes CONNECTED/connected to SYNC_FAILED/needs_reconnect and the original assertion fails. A test-only fixture-owner filter on both scheduler invocations preserves all native scheduler predicates and operations; the same command then passes. The normal owned success case and failed-mailbox case still run their original assertions. The added foreign snapshot equality also protects the remaining credential, and the second mailbox case exercises restoration across distinct fixture users.

## Solution

Applied exact reviewed patch: in integration-accounts.pipelines.cases.ts, intersect the test process's native Integration.findMany candidate query with the fixture user ID, run the unchanged scheduler, and restore the query method in finally. Apply to both existing Gmail pipeline calls. Add gmail-delete-ownership.blackbox.ts, discovered by the existing canonical runner, to reproduce the interference against the unchanged DELETE test and verify sibling success/failure controls. No runtime code, status expectation, timeout, case concurrency, production scheduler eligibility, or existing case body is relaxed.

The coordinator reviewed and applied the exact native-tested proposal. Final combined-source gates remain pending. No shared source or archive/index was written by this worker.

## Search and recurrence

Archive literal search: `integration should stay connected`.
Behavioral search: `gmail account delete remaining credential integration status disconnected`.
Read the nearest Gmail multi-account case and the fixture-ownership relative 2026-10-15-send-sms-suite-inherited-whatsapp-fallback, including Solution and Human feedback. Neither identifies this global test scheduler scan. This is a related fixture ownership failure, not a demonstrated recurrence of either prior first-bad boundary.

## Limits and rejected evidence

The original full 228-domain run is retained and was not repeated by this worker. The exact historical failed-status value was not logged by its assertion; the local controlled reproduction establishes SYNC_FAILED and credential needs_reconnect. The original timestamps, matching user and native scheduler trace establish the historical writer. No production Gmail behavior defect is claimed.

Initial reproduction scaffolds failed because node:test mock.method cannot locate this Prisma proxy's dynamically exposed method, and because the two native session helpers name their token fields differently. A subsequent reference-identity cleanup assertion was invalid because this Prisma proxy returns fresh function wrappers. These logs are retained and excluded from causal red/green claims. The final regression uses real database state equality and the unchanged original assertion.

## Coordinator constraints

The coordinator requires original native assertions, local-only fixtures and database resources, no source mutations by this worker, no assertion/deadline weakening, and a concrete reviewed proposal before application. Freedom and its settings remain untouched.

## Final native evidence

The final proposal hash is `eb57bb2b5f07d3ea261e85b94f5e2d9023880646463f57c408f758101934f300`. With the final regression held byte-identical, `run-adversarial.sh` failed on the original scheduler caller and passed after replacing only that scratch caller with the proposed owner-scoped caller. Five consecutive final-hash runs (4 through 8) then passed, including the original DELETE acceptance and both native mailbox outcomes. The affected domains passed together: integrations 275/275 and integration-accounts 29/29. Both proposed files pass lint. The extra test-inclusive TypeScript probe still reports two errors in unchanged integrations.lantern.cases.ts:386/391; it reports no proposed-file error and is not claimed as a passing full type check.

All execution sessions were joined. All 562 Node PIDs recorded in owned raw-V8 artifacts were absent afterward, both owned backend ports refused connections, and both uniquely named local databases were dropped after zero active sessions. See cleanup.json. No shared source or archive/index change was applied; the case remains open for coordinator application and final combined gates.


## Human feedback

No additional user feedback was recorded. The coordinator required fixture-owned queries and preservation of native scheduler eligibility and all original assertions; no production scheduler behavior was changed.

## Reusable lesson

A domain fixture invoking a global scheduler must confine its candidate inputs to owned rows before executing native writes on a shared test database.
