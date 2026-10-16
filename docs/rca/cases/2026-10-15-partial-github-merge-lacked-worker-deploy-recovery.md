---
id: 2026-10-15-partial-github-merge-lacked-worker-deploy-recovery
date: 2026-10-15
title: Partial GitHub merge exposed a missing worker deployment recovery trigger
surface: infra
component: deploy-agents-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A confirmed merged source had no push-triggered deployment run and the existing deployment workflow rejected manual dispatch
symptoms:
  - "GraphQL: Something went wrong while executing your query"
  - "Workflow does not have 'workflow_dispatch' trigger"
tags:
  - deployment
  - github-actions
  - source-identity
  - recovery
sources:
  - task https://github.com/Rose-Ai-Labs/rose/pull/1511
  - task .context/rca-ae17b024/production-merge-receipt.json
  - task .context/rca-ae17b024/production-merge-reconciliation.json
  - task .context/rca-ae17b024/production-pr-merged-confirmed.json
  - task .context/rca-ae17b024/manual-dispatch-before.txt
  - task .context/rca-ae17b024/manual-dispatch-after.txt
repro: bash scripts/tests/workflow-deployment-migration.test.sh
status: fixed
---

## Problem

The normal exact-head merge for PR1511 returned a GitHub GraphQL server error
after publishing main commit `a59f19b1ca7c77acae1b754318609faa487f0b6f`.
Its parents were the expected main and reviewed PR head, and its tree was
byte-identical to the reviewed source. GitHub nevertheless continued to report
the PR open and unmerged. No worker deployment run appeared for that commit.
The public status page reported no incident; a wider outage is not established.

A single supported asynchronous merge retry, after the ten-minute cadence,
returned terminal `failed: Pull Request is not mergeable`. Refreshing the PR's
existing `base=main` target subsequently made GitHub report the original commit
as merged and closed, with the canonical merge endpoint returning HTTP204.
This changed neither source nor the target branch, and did not manually close
the PR or push a target ref. Missing deployment events still prevented rollout.

The native recovery command `gh workflow run deploy-agents.yml --ref main`
then failed with HTTP422 because the workflow supported only push events.
The missing manual entry point is our operational contract gap. The GitHub
server failure is observed external behavior, not attributed to agent code.

## Diagnosis

The existing workflow already owns serialized cooperative deployment, source
hashing, exact build/run-attempt provenance, pointer activation, draining and
old-worker retirement. Reimplementing that owner locally or manufacturing an
empty source commit would bypass the supported deployment path. A manual
entry point should enter the same workflow and reject a stale source request
before checkout, credentials, image creation or production mutation.

## Solution

Add `workflow_dispatch` with a required `expected_sha`. Its first step requires
both `refs/heads/main` and `expected_sha == GITHUB_SHA`. Existing push behavior,
workflow permissions, concurrency serialization, activation classification,
provider credentials, cutover budgets and run-attempt token remain unchanged.
The application and agent runtime are unchanged from the reviewed merge.

The owning structural suite executes the actual new guard body under three
environments: exact main succeeds, a mismatched SHA fails, and another branch
fails. It also requires the guard to precede every deployment step. The same
fixture fails on the original workflow and passes after repair; all existing
cooperative clone/recovery controls remain. No external workflow or provider is
launched by these tests. Production deployment and its verification remain
separate required gates; a passing structural test does not certify rollout.

## Human feedback

The user requested finishing the incident repair and reusing established
timeout/LLM owners. This follow-up restores access to the existing deployment
owner, without changing runtime retry behavior or adding harness narration.

## Reusable lesson

A push-only production workflow needs a source-pinned recovery entry point.
Verify the actual merged tree and deployment attempt separately when a hosting
API partially commits a merge; never infer successful rollout from the ref.
