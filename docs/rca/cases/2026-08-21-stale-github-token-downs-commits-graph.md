---
id: 2026-08-21-stale-github-token-downs-commits-graph
date: 2026-08-21
title: Stale Render GITHUB_TOKEN returned 401 and blanked the Company Health commits graph
surface: back-end
component: admin-health
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Render env GITHUB_TOKEN — fine-grained PAT returns 401 Bad credentials on /repos/Rose-Ai-Labs/rose/commits while GITHUB_DISPATCH_TOKEN still works
symptoms:
  - Company Health "GitHub Commits Landed" shows Unavailable
  - series.githubCommits is null for every bucket (empty chart)
  - velocity.dev.githubCommitsLanded.status === error detail GitHub 401
  - Render logs also show Failed to create repo status 401 Bad credentials
tags:
  - admin-health
  - github-token
  - velocity
  - commits-graph
sources:
  - curl Render GITHUB_TOKEN vs GITHUB_DISPATCH_TOKEN against commits API
  - local repro scripts/repro with stale token → status error
repro: local
status: fixed
---

## Problem

The Company Health "GitHub Commits Landed" chart rendered Unavailable / null
series because `fetchGithubItems` only used `process.env.GITHUB_TOKEN`. On
Render that PAT is present but dead (`401 Bad credentials`).

## Diagnosis

Step 0 evidence:

1. Render `GITHUB_TOKEN` (len 93, `github_pat_…`) → `401` on
   `/repos/Rose-Ai-Labs/rose/commits?per_page=1`.
2. Render `GITHUB_DISPATCH_TOKEN` (len 40, `gho_…`, scopes include `repo`) → `200`.
3. Local velocity call with only the Render PAT →
   `githubCommitsLanded.status=error`, `detail=GitHub 401`, all
   `buckets[].githubCommits=null`.

Same class as `2026-07-15-stale-classic-github-token-busts-admin-health-day-cache`
(stale GitHub credential breaks velocity), but this time the UI symptom is the
commits graph itself, not only day-cache reuse.

## Solution

1. Resolve commit-fetch auth via `githubApiTokenCandidates()` —
   `GITHUB_TOKEN` then `GITHUB_DISPATCH_TOKEN` — and on `401`/`403` try the next
   candidate instead of marking the whole series `error`.
2. Apply the same fallback to `createGithubRepo` (same dead token).
3. Cement with
   `back-end/src/tests/unit/admin-health-github-velocity-fallback.test.ts`.

Rotate / replace Render `GITHUB_TOKEN` when a fresh PAT is available (env write
needs approval); the DISPATCH fallback keeps the graph up until then.

## Human feedback

None recorded.

## Reusable lesson

A present GitHub token is not a working GitHub token. Admin-health and other
GitHub API callers must ignore 401/403 credentials and fall through to
`GITHUB_DISPATCH_TOKEN` (or another validated candidate) rather than treating
"env var set" as success.
