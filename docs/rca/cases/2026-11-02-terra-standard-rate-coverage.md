---
id: 2026-11-02-terra-standard-rate-coverage
date: 2026-11-02
title: Terra usage is absent from API-equivalent cost estimates
surface: back-end
component: admin-health-costs
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Bare and OpenRouter-prefixed GPT-6.1 Terra usage remains unpriced.
symptoms:
  - Terra usage is absent from API-equivalent cost estimates
  - Bare and OpenRouter-prefixed GPT-6.1 Terra usage remains unpriced.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942832
  - plan:/project/rose-speed-comparison-20261028/nov2-final-review-terminal-repair/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

Bare and OpenRouter-prefixed GPT-6.1 Terra usage remains unpriced.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Add both model IDs using verified standard rates: input 1, output 5, cache read 0.05, and 30-minute cache write 1.25 USD per million. Preserve unknown-model accounting and existing standard API-equivalent scope.

## Validation

Opened the [official OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra) and [OpenRouter model page](https://openrouter.ai/openai/gpt-6.1-terra/) independently. Both publish the standard rates used here. Exact permanent cost controls fail before and pass after; integrated admin-health period metrics owner passes. These are standard API-equivalent estimates, not actual subscription charges or speed/long-context-adjusted invoices.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
