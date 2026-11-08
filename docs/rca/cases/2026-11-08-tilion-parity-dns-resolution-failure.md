---
id: 2026-11-08-tilion-parity-dns-resolution-failure
date: 2026-11-08
title: Hosted Tilion parity browser could not resolve example.com
surface: back-end
component: browser-provider-live-parity
classification: third-party-failure
problem_class: other
first_bad_boundary: hosted browser navigation returned ERR_NAME_NOT_RESOLVED for example.com
symptoms:
  - "page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/"
  - "FAIL live Tilion provider parity"
tags:
  - tilion
  - dns
  - external-provider
sources:
  - PR #1831
  - commit 66adafe0bb9707fbc0568eb298773e1483402327
  - plan:.context/production-mixed-mode-evidence/tilion-dns-waiver-prepared.json
repro: none-recorded
status: mitigated
---

## Problem

The actual backend browser-provider domain failed live Tilion parity at
12:28:44 UTC with the literal hosted navigation DNS error. Its native FAIL
remains in the deployment history. Kernel/Steel auth persistence and Tilion
challenge recovery passed in the same native domain. Native session DELETE204
and inventory cleanup were recorded; backend cleanup completed.

## Diagnosis

Gate: NOT_INTRODUCED against frozen main 2f5f1789cc3e233e991082347241c3926a94e9a9
for the identified provider, browser, coverage and helper closure (empty diff).
Two archive searches and regional-CDP classifier and tunnel NXDOMAIN cases were
read; neither proves a recurrence of those first-bad boundaries. This evidence
supports unavailability of the hosted browser DNS path, not a provider-wide
incident, worker death, or the separate browser watchdog cancellation failure.
No local blackbox causal reproduction of remote DNS is claimed.

## Solution

Apply only the standing external-provider outage exception to this exact native
failed case, preserving FAIL with warning. Do not change URL, DNS, credentials,
timeouts or assertions, and do not repeat the paid case solely to seek green.
No code repair or permanent local regression is claimed for an external DNS
failure. Golden reference: not applicable.

## Human feedback

The user forbids treating the production mixed-mode payment ERROR as an
external-outage waiver; that original result and all three financial duties
remain separate and unverified.

## Reusable lesson

Qualify a hosted DNS failure from its native navigation evidence without extending the exception to unrelated lifecycle failures.
