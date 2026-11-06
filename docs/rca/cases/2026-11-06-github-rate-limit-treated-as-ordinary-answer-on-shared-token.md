---
id: 2026-11-06-github-rate-limit-treated-as-ordinary-answer-on-shared-token
date: 2026-11-06
title: A GitHub rate limit was an ordinary answer on every code-agent path but repo creation, so a limited merge lookup reported merged no, confirmed with GitHub
surface: cross
component: github
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "back-end/src/providers/codeSessions/mergeFacts.ts githubJson/resolveMergeFacts (and github.ts checkGithubRepoAccess, codePreview/publish.ts, e2b-templates/*/ws-server.mjs prepareCodeSessionBranch): a 403/429 from GitHub resolved like any non-200 answer, no shared boundary owned GitHub's rate-limit contract, and the facts derived from the answer had no 'GitHub did not answer' state"
symptoms:
  - "Merged: no (confirmed with GitHub) while GitHub had only answered 403 'API rate limit exceeded for <ip>'"
  - "Access denied: You don't have permission to clone <owner>/<repo>. Please contact support to request access. (a rate-limited visibility check)"
  - "base branch <branch> is not on the remote (git fatal: unable to access ...: The requested URL returned error: 429)"
  - "Failed to create code session (provider=claude): HTTP 429"
  - "[Setup] Failed to clone repository: Command failed: git clone https://x-access-token:<token>@github.com/... (codex ws-server)"
tags:
  - github
  - rate-limit
  - secondary-rate-limit
  - retry-after
  - shared-credential
  - code-agent
  - merge-facts
  - false-confirmation
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
  - memory:feedback-never-rotate-tokens-without-permission
  - commit e68f1fc50
  - commit 0dbf5c6e5
repro: back-end/src/tests/blackbox/code-session-merge-facts.blackbox.ts
status: fixed
---

## Problem

Andy, reviewing the Rose-on-Rose code-agent run: "we need to make sure we handle scenarios were gh is rate limited, for pulls or w/e". Every code-agent GitHub path uses one server token (the backend `GITHUB_TOKEN`, injected into every sandbox), so every sandbox and every user shares one GitHub bucket. Only repo creation honoured a limit (2026-10-28, PR #1621). The other call sites treated a 403/429 as an ordinary answer.

Run evidence (prod, read-only, root agent `1a3d495c` "Rose Repo Status", session `50939d30`): the code agent reported "`gh` isn't installed" and used the REST API with the token from the git remote. None of the 396 code-agent sessions of the last 30 days has a rate-limit message in its recorded output (a read-only regex over `ClaudeCodeSession.output`; sessions with no recorded output are not covered), and a Render log search for "rate limit" since 2026-10-29 found no GitHub limit lines (the 10-28 repo-create lines were fixed in #1621). So no code-agent limit hit is on record; the defect is exposure, proven by the repro below. Live occurrence while this RCA ran (2026-11-06): the devbox's shared GitHub credential helper refused pushes for every parallel agent ("GitHub API rate limit reached; try again in 27 minutes"), the same one-bucket failure at small scale. That tool text is the devbox helper's, not GitHub's, and is not used as a fixture.

Fail-before, real GitHub primary-limit response served by the fake GitHub (fixtures are captures, see Diagnosis), unchanged code:
- `resolveMergeFacts` returned `source: "github"`, `pr: null`, `merge_target_contains_head: false` (GitHub never answered the compare), then rendered to Rose as "Merged: no (confirmed with GitHub)", was persisted, and spent a second call into the limit.
- `checkGithubRepoAccess` returned "Access denied ... contact support"; the agents side got a generic retryable `Exception: Failed to create code session ... HTTP 429`.
- `publishCodeSessionBranch` returned a 502 `PR_CREATE_FAILED`.
- Both ws-servers reported a 429 on the base fetch as "base branch main is not on the remote", and the codex clone failure logged and wrote the full `git clone https://x-access-token:<token>@github.com/...` command.

## Diagnosis

Searches: `rca_archive.py search` for "github secondary rate limit 403 retry-after repo creation" and "github rate limited clone fetch push code agent sandbox", plus the literal strings above. Relative of `2026-10-28-github-agent-repo-creates-tripped-secondary-rate-limit` (same shared token and same limit, different boundary and symptom); that case's lesson, "honour Retry-After globally", was implemented inside `createGithubRepo` only.

Step 5a ladder, each rung with evidence:
1. **First bad (data path):** call sites resolve a 403/429 like any other answer. Evidence: `githubJson` returned `{status, body}` and never read headers; `fetchGithubRepoVisibility` returned `unknown`; publish mapped it to 502; ws-server's fetch failure was always "not on the remote". Local repro below.
2. **Why possible:** no single boundary owns GitHub's rate-limit contract. After #1621 the only classifier (`isRateLimited`, `retryAfterMs`) was private to `createGithubRepo`; the other call sites had none and there was no process-wide block, so each request found out for itself.
3. **Why possible (contract):** values derived from an answer carry no "how GitHub answered". `source: "github"` was set after any response, the agents rendered "(confirmed with GitHub)" unconditionally, and "unknown" had no representation. Siblings this also fixes: `github_unavailable` rendered as a confirmed "no"; the access check mapping a limit to a denial; a limited PR create as a generic 502; a refused base fetch as a missing branch.
4. Next "why" is that one personal token serves every sandbox. That is a deliberate design owned by the (deferred) GitHub App work; stop here.

Fixture provenance (the fake never invents GitHub wording): `primary-403.json` is a real unauthenticated `GET /repos/octocat/Hello-World` 403 captured 2026-11-06T05:05:13Z (status, all 20 headers, body); the devbox's shared egress IP had already spent its 60/h, so the capture consumed nothing. `secondary-403.json` is the real status and body from production Render logs of 2026-10-28T01:29:49Z (headers were not logged). `retry-after` is added only when a test asks, per GitHub's documented rule. git text is generated by the real git client against the fake: on 429 or 403, with or without Retry-After, `git clone` exits 128 at once with `fatal: unable to access '<url without credentials>': The requested URL returned error: 429` (git 2.43 here made one request and did not wait on Retry-After; the sandbox image is ubuntu:22.04, whose packaged git is older, and was not run here). Gaps, stated plainly: GitHub documents no git-transport limit text and git never exposes a reset time to the sandbox; the `gh` CLI refuses to run unauthenticated, so its limit stderr could not be captured without a token and a really exhausted bucket, and `gh` is not installed in the sandbox anyway.

Local repro (failed before, passes after): `code-session-merge-facts` blackbox "a rate-limited GitHub is reported as limited with its reset time" (expected `source github_rate_limited`, actual `github`) and "a short secondary limit is waited out once"; `github-agent-repo` blackbox (access check and project clone); `github-rate-limit` blackbox (publish 502 vs 429); agents `code-agent-github-rate-limit`; `github-create-repo-fallback` unit; and the template test `git-rate-limit.test.mjs` (4 of 6 failed before: token in output, 429 reported as missing branch).

## Solution

- `back-end/src/providers/githubRateLimit.ts` owns the contract: classify by status and headers per GitHub's docs (`retry-after`, then `x-ratelimit-reset` when `remaining` is 0, else a minute; the JSON message is read only for GitHub's header-less secondary 403, and a 429 is always a limit); one process-wide block so a limited call stops every later call until the reset (blocked calls never reach GitHub); `githubFetch` waits out limits that end within a 15 s budget for reads, never replays a sent write (rule 20), and otherwise throws `GithubRateLimitedError` carrying the reset time.
- Callers: merge facts (`source: github_rate_limited`, `rate_limited_until`, `merged` unknown), access check, project clone, publish (429 with the reset time), `createGithubRepo` (shares the block), change-watch head poll (never waits).
- Create-session returns 429 `GITHUB_RATE_LIMITED` with `reset_at`; the agents map it to a typed non-retryable error and fail the tool with the exact message; the "Merged:" line says unknown when GitHub never answered.
- Sandbox: both ws-servers report a refused base fetch with git's own output unless `git ls-remote --exit-code` says the branch is absent (exit 2), and mask credentials in every git error path.
- `agents/benchmarks/github_rate_limit_check.py`: the code-agent benchmark's check of a finished run.

At 10,000 agents: all agents share one bucket, so the design bounds traffic into it. Once limited, each backend process answers every GitHub call from memory (zero GitHub traffic, zero waiting for blocks beyond the 15 s budget), at most three attempts per call, no per-agent state. Conditional requests and reusing the restored project snapshot instead of re-cloning would cut calls further, and per-installation tokens (a GitHub App, deferred) would split the bucket; neither is built here. Open item, not changed: the Rose project setup's `repoReachable` check still shows "not connected" under a limit.

## Human feedback

Andy said we need to make sure we handle scenarios were gh is rate limited, for pulls or w/e. Via the orchestrator: the fake GitHub must return exactly what real GitHub returns (verbatim status, headers and bodies, sourced, with a drift test); never rotate or replace any credential; do not edit the false `gh` claim in `web_fetch.py` (a prompt change, listed for approval); resolved afterwards by installing `gh` in both sandbox images, which makes that claim true.

## Reusable lesson

Own a third-party rate limit at the one boundary every call goes through, and give every fact derived from that call an explicit "the provider did not answer" state, so a limited lookup can never be reported as a confirmed answer.
