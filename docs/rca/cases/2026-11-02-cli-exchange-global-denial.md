---
id: 2026-11-02-cli-exchange-global-denial
date: 2026-11-02
title: Distributed invalid logins deny unrelated CLI users
surface: back-end
component: cli-login
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Sixty addresses exhausting ten invalid codes each trigger a global 600-failure denial for unrelated users.
symptoms:
  - Distributed invalid logins deny unrelated CLI users
  - Sixty addresses exhausting ten invalid codes each trigger a global 600-failure denial for unrelated users.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942860
  - plan:/project/rose-speed-comparison-20261028/nov2-final-review-terminal-repair/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

Sixty addresses exhausting ten invalid codes each trigger a global 600-failure denial for unrelated users.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Retain per-address and bounded overflow quotas, authentication, code entropy and single-use semantics. Global address-spraying threshold emits one structured warning per window instead of denying unrelated clients.

## Validation

Original permanent callback fails; candidate passes per-client denial, unaffected client, rollover, bounded overflow and warning controls. Integrated cli-login owner passes.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
