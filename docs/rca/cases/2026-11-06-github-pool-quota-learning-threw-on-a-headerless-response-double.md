---
id: 2026-11-06-github-pool-quota-learning-threw-on-a-headerless-response-double
date: 2026-11-06
title: The GitHub token pool read response.headers unconditionally, so a minimal Response double crashed github-agent-repo
surface: back-end
component: github-token-pool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/githubTokenPool.ts sendWithToken passed response.headers to recordGithubResponse without tolerating a missing value
symptoms:
  - "Cannot read properties of undefined (reading 'get')"
  - "GitHub branch head lookup errored owner=fixture repo=repo branch=topic/branch"
  - "Error: fixture timeout"
  - "FAIL  github-agent-repo"
tags:
  - github-token-pool
  - blackbox
  - fetch-stub
  - advisory-side-channel
sources:
  - PR #1723
  - commit e08b166e0faf8131c8a48de1bfd0326daeb5a37f
  - task /var/tmp/deploy-workers/backend-coverage/back-end/coverage/blackbox-run-shard1/github-agent-repo.log
repro: back-end/src/tests/blackbox/github-agent-repo.blackbox.ts
status: fixed
---

## Problem

The staged `/deploy` backend-coverage gate of PR #1723 failed `blackbox:github-agent-repo` (one of 249 cases). The log shows `GitHub branch head lookup errored ... error=Cannot read properties of undefined (reading 'get')`, then the process exited with an uncaught `Error: fixture timeout` raised from the test's own fetch stub.

## Diagnosis

Gate: INTRODUCED. This PR routed `fetchGithubBranchHeadSha` through `githubFetch`. `verifyHeadLookupTimeout` in the blackbox is a pure HTTP seam: its body-stall case returns `{ ok: true, text: () => pending } as Response`, a stub with no `status` and no `headers`. `sendWithToken` handed `response.headers` to `recordGithubResponse`, whose first statement calls `headers.get(...)`, so the lookup threw `TypeError` before it could await `text()`. The stub's `pending` promise was never awaited, so its later rejection (`fixture timeout`) became an unhandled rejection and killed the process.

Local repro (scratch clone of e08b166e0, isolated database): `bash scripts/run-blackbox-tests.sh github-agent-repo` from `back-end` printed `FAIL  github-agent-repo` with both errors. With the fix the same unchanged command prints `PASS  github-agent-repo`.

The deepest owned cause: learning a member's quota is an advisory side channel, and the pool let it fail the read it was meant to observe.

## Solution

In `sendWithToken`, treat `response.headers` as possibly absent and learn from an empty `Headers` in that case, so a minimal response double passes through untouched. The registered regression is `back-end/src/tests/unit/github-token-pool.test.ts` (a response double with no status or headers must pass through): it throws `TypeError: Cannot read properties of undefined (reading 'get')` at `recordGithubResponse` without the fix and passes five consecutive runs with it. The original blackbox stays unchanged and owns the end-to-end seam. Real `fetch` always returns headers, so production behavior is unchanged. 10k agents: no change (one `Headers` allocation only on the doubles path).

## Human feedback

None recorded.

## Reusable lesson

Code that observes a response for a side purpose (quota, metrics, logging) must tolerate a minimal response and never throw into the caller's read path.
