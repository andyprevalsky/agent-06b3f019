---
id: 2026-10-03-agents-boundary-github-first-url-picked-dispatches
date: 2026-10-03
title: Create-agent GitHub boundary took the first api.github.com capture and failed on auto-RCA /dispatches
surface: backend
component: agents-blackbox
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/agents-boundary.cases.ts testBoundary_createAgentGithubRepo used githubCalls[0] from the shared capture buffer
symptoms:
  - "FAIL  boundary — create agent calls GitHub for repo creation"
  - "Expected GitHub repos URL, got https://api.github.com/repos/Rose-Ai-Labs/rose/dispatches"
tags:
  - deploy
  - blackbox
  - capture
sources:
  - PR #1406
repro: back-end/src/tests/unit/github-repo-capture-select.test.ts
status: fixed
---

## Problem

Deploy backend coverage (`runId=1790994767-56482-20366`) failed the `agents` domain 236/237. The sequential GitHub repo-creation boundary asserted the first `api.github.com` capture was `POST /user/repos`. Under `domainConcurrency=4` a sibling domain's auto-RCA `POST .../dispatches` landed first in the shared buffer.

Local first-match repro of that capture list:

```
Expected GitHub repos URL, got https://api.github.com/repos/Rose-Ai-Labs/rose/dispatches
```

Archive searches for that exact string and for "shared capture buffer github user/repos" found no matching first-bad boundary. Sibling tests (`testBoundary_createAgentCallOrdering`, validation short-circuit) already scoped with `X-Capture-Token`.

## Diagnosis

`testBoundary_createAgentGithubRepo` called `clearCaptures()` + `readCaptures()` (global buffer) and took `githubCalls[0]`. Repo creation and auto-RCA dispatch share `api.github.com`. The first URL in a concurrent coverage run is not the create-agent fire-and-forget. Product `createGithubRepo` still posts to `/user/repos`; the assertion, not agent create, was wrong.

## Solution

Select `https://api.github.com/user/repos` only (`selectGithubRepoCreationCall`) and scope the create request with `X-Capture-Token`. The unit test pins that a `/dispatches`-first list is what the old first-match did and that the selector returns `/user/repos`. Isolated `agents` blackbox plus coverage must stay green.

No extra per-agent work at 10k agents — test-only.

## Human feedback

None recorded.

## Reusable lesson

When a capture assertion names one outbound URL, filter that exact URL and scope with `X-Capture-Token`. Do not take the first host match from a shared buffer.
