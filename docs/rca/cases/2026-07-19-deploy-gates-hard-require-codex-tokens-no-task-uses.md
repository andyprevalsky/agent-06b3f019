---
id: 2026-07-19-deploy-gates-hard-require-codex-tokens-no-task-uses
date: 2026-07-19
title: Three `/deploy` gates hard-require Codex credentials that none of their tasks actually use
surface: harness
component: deploy-pipeline
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/seed-local.ts syncComputeTokensWithRetries — throws "No usable gpt_code integrations after sync" during run-predeploy-local seed even though no smoke task uses Codex
symptoms:
  - "No usable gpt_code integrations after sync"
  - "You've hit your usage limit… resets <date>"
  - "Quota exceeded" from codex inside the E2B sandbox
  - backend-coverage stage exits 1 while coverage thresholds pass
tags:
  - codex
  - deploy-gate
  - quota
  - third-party-outage
  - smoke
sources:
  - memory:project_codex_quota_blocks_deploy_gates
repro: none-recorded
status: mitigated
---

## Problem

When the pooled ChatGPT Codex OAuth (`gpt_code` integrations) is
quota-exhausted or rate-limited, three `/deploy` gates fail on changes that have
nothing to do with Codex: (1) the codex-code blackbox smoke, where the E2B
sandbox runs codex against the exhausted OAuth and gets `Quota exceeded`;
(2) backend-coverage, which includes that same smoke and therefore exits 1 even
though coverage thresholds pass; and (3) the pre-deploy smoke, whose seed step
throws `No usable gpt_code integrations after sync`.

## Diagnosis

Two independent couplings. First, the funded `OPENAI_API_KEY`/`GPT_API_KEY`
fallback in `resolveCodexCodeAuthEnvs` (`back-end/src/providers/e2b.ts`) does not
rescue an _immediate first-turn_ quota hit, so the codex-code smoke has no path
to green during a quota outage. Second, `run-predeploy-local`'s seed calls
`syncComputeTokensWithRetries` (`back-end/scripts/seed-local.ts`) and treats a
missing usable `gpt_code` integration ("usable" = CONNECTED and not
rate-limited) as fatal — even though none of its 6 smoke tasks use Codex at all.
The deeper owned cause is that a gate's credential preconditions are broader than
the credentials its tasks actually consume, so any third-party quota outage
becomes a hard stop for unrelated work. `backend-coverage` compounds it by
bundling an external-dependency smoke into a threshold check, conflating two
different failure meanings in one exit code.

## Solution

Two sanctioned bypasses exist, and both loudly announce the skip so a real
regression still surfaces: `BLACKBOX_TEST_SKIP_DOMAINS=codex-code` (escape hatch
in `src/tests/blackbox/run.ts`, meant exactly for external billing/credential
blocks) and `SEED_ALLOW_MISSING_GPT_CODE=1` (guarded in `seed-local.ts:308`;
`scripts/run-agentcard-lifecycle-task.sh:50` already sets it). The durable fix,
not yet landed, is for `run-predeploy-local` to set
`SEED_ALLOW_MISSING_GPT_CODE` itself whenever its fixed smoke set contains no
Codex task — today every workspace's smoke blocks during a Codex outage.

## Human feedback

The human requires explicit authorization before either bypass is used: they are
for genuine external quota outages only, never for masking a real Codex
regression.

## Reusable lesson

A gate must only hard-require the credentials its own tasks actually consume —
derive the precondition from the selected task set instead of seeding every
credential unconditionally.
