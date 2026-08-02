---
id: 2026-07-26-plaid-env-set-to-sandbox-on-render
date: 2026-07-26
title: `PLAID_ENV` was `sandbox` on Render while real items were linked in production
surface: back-end
component: plaid-credentials
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Render env var PLAID_ENV=sandbox — every API call for a production-linked item hit the sandbox host
symptoms:
  - "INVALID_ACCESS_TOKEN: expected \"sandbox\", got \"production\""
  - PlaidItem rows in ERROR status with no recoverable sync
tags:
  - plaid
  - env-vars
  - render
  - environment-mismatch
sources:
  - memory:project_plaid_key_rotation_orphaned_items
repro: none-recorded
status: fixed
---

## Problem

Prod Plaid items that were linked against Plaid production failed every API call
with `INVALID_ACCESS_TOKEN: expected "sandbox", got "production"`. This was a
second, independent cause of the all-ERROR `PlaidItem` state found in the
2026-07-26 audit.

## Diagnosis

The `PLAID_ENV` variable on Render was set to `sandbox` while the access tokens
stored for real users had been minted in Plaid's production environment. Plaid
rejects a production token presented to the sandbox host with exactly the
`expected "sandbox", got "production"` error, so no item could ever sync. The
misconfiguration was silent: nothing at startup validated that the configured
Plaid environment matched the environment the stored tokens were issued for.

## Solution

`PLAID_ENV` was set to `production` on 2026-07-26 (user-approved). Two operational
notes recorded with the fix: a Render env-var write via the API does **not**
auto-trigger a deploy, so the change takes effect only on the next deploy; and
`PLAID_DEFAULT_PRODUCTS` deliberately differs by environment — production omits
Auth/Identity because Plaid has not approved them, and requesting them fails
`/link/token/create` with `INVALID_PRODUCT`.

## Human feedback

Writing the production env var required explicit user approval, per the standing
rule on production env-var changes.

## Reusable lesson

When a provider rejects a token with an environment mismatch, check the deployed
`*_ENV` variable before the token — and remember a Render env-var write does not
take effect until the next deploy.
