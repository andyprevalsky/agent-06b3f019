---
id: 2026-08-23-public-github-repo-auto-grant
date: 2026-08-23
title: Codex code session returned GITHUB_ACCESS_DENIED for a public third-party repo the agent needed to verify
surface: back-end
component: github-repo-access
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/github.ts:checkGithubRepoAccess — denied any repo not pre-seeded in GithubRepoAccess, even when the repo is public and cloneable without credentials
symptoms:
  - 'Failed to create code session (provider=codex): HTTP 403: {"error":"Access denied: You don''t have permission to clone icl-utk-edu/magma. Please contact support to request access.","code":"GITHUB_ACCESS_DENIED"}'
  - Code session failed
tags:
  - codex
  - github
  - github-access-denied
  - spawn-claude-code-agent
sources:
  - agent 14e0ca67-7db4-406d-a4e9-dcd2f4068eb8
repro: back-end/src/tests/unit/github-public-repo-access.test.ts
status: fixed
---

## Problem

Agent `14e0ca67-7db4-406d-a4e9-dcd2f4068eb8` was verifying public GitHub repo
`CHAI-MAGMA/magma` and spawned a Codex code session against the canonical public
repo `icl-utk-edu/magma`. Session creation returned HTTP 403
`GITHUB_ACCESS_DENIED` even though the repo is public (`private: false` on the
GitHub API). The agent already had working `web_fetch` access to the same URLs;
only the code-session clone path was blocked.

Separately, the explore chip header showed ghost/overlapping characters while
long `web_fetch` titles rotated in `ExploreActiveToolCarousel` (`mode="popLayout"`
let enter and exit labels render on top of each other).

## Diagnosis

Critical path: `spawn_claude_code_agent` → codex code session create endpoint
→ `checkGithubRepoAccess` → `GithubRepoAccess` DB lookup only → 403.

Prod evidence (message index 85 on agent `14e0ca67-7db4-406d-a4e9-dcd2f4068eb8`):

```
Exception: Failed to create code session (provider=codex): HTTP 403:
{"error":"Access denied: You don't have permission to clone icl-utk-edu/magma.
Please contact support to request access.","code":"GITHUB_ACCESS_DENIED"}
```

`https://api.github.com/repos/icl-utk-edu/magma` returns 200 with
`private: false`. The allowlist was designed for agent-owned workspaces, but
code-session callers can pass any `github_repo_link`; public repos were treated
like private ones.

UI: explore header carousel used `AnimatePresence mode="popLayout"` without
absolute positioning, so two long truncated fetch titles overlapped during
rotation (user-reported ghost `i/j` characters behind the label).

## Solution

1. **Public repo auto-grant** (`back-end/src/providers/github.ts`): after a
   failed allowlist lookup, call GitHub's repo metadata API; when `private` is
   false, persist `GithubRepoAccess` and allow the session. Private/missing repos
   still 403 before E2B.
2. **Carousel overlap fix** (`ExploreActiveToolCarousel.tsx`): switch to
   `mode="wait"`, fixed height, and absolutely positioned labels so only one
   title is visible at a time.
3. **Regression tests**: `github-public-repo-access.test.ts` (unit) and updated
   explore carousel blackbox.

10k-agent behavior: one GitHub metadata lookup per user/repo pair on first code
session; result is cached in `GithubRepoAccess`, so retries and later agents for
the same user do not re-hit GitHub. No per-agent fan-in.

## Human feedback

None recorded.

## Reusable lesson

When code sessions accept arbitrary `github_repo_link` values, auto-grant public
repos after a GitHub visibility check instead of requiring a pre-seeded allowlist
row for every third-party repository.
