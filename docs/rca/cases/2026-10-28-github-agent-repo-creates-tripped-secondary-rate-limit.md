---
id: 2026-10-28-github-agent-repo-creates-tripped-secondary-rate-limit
date: 2026-10-28
title: Per-chat GitHub repo creates on one shared token, 96% from non-production stacks, tripped GitHub's secondary limit for production code agents
surface: back-end
component: github
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/domains/agents/agentLifecycleService.ts startChatMode called createGithubRepo for every chat-mode root agent in every environment, using the single GITHUB_TOKEN shared by production and every local, benchmark and devbox stack, with no pacing or Retry-After handling"
symptoms:
  - "Render: component:GitHub \"Failed to create repo\" status 403 \"You have exceeded a secondary rate limit and have been temporarily blocked from content creation\" (agent-e3114b4f and others), 2026-10-28 00:39Z → 03:18Z+"
  - "production users' code agents started without their workspace repo while the block lasted"
  - "the token's account (andyprevalsky) holds 50,000 public repos"
tags:
  - github
  - rate-limit
  - secondary-rate-limit
  - shared-credential
  - benchmarks
  - scale
sources:
  - agent e3114b4f (Render prod logs, 2026-10-28 403 secondary rate limit)
  - memory:s13-db-growth-preflight-lane
repro: back-end/src/tests/unit/github-create-repo-fallback.test.ts
status: fixed
---

## Problem

Starting at 2026-10-28 00:39Z, production repo creates failed with GitHub's secondary content-creation limit (403). Production code agents ran without their workspace repo for hours.

## Diagnosis

The 3,000 most recent `agent-*` repos (2026-10-27 02:56Z onward, read-only via the GitHub API) were created at 150–300 per hour around the clock, pinned at GitHub's content-creation ceiling. Matching each `agent-<id8>` against production `Agent` ids (primary-key range lookups, read-only) showed:
- only 119 of 3,000 (4%) belong to production agents, 22 of them production benchmarks;
- the other 96% came from local, benchmark, smoke, coverage and devbox stacks. Over ~20 parallel `/deploy` lanes ran these that day.

Production's `GITHUB_TOKEN` and every stack's `back-end/.env` hold the same personal access token (account `andyprevalsky`), so all of them drew on one account-wide secondary limit.

`startChatMode` created a repo for every chat-mode root agent, fire-and-forget, even though only code sessions ever use one. The `agents-boundary` blackbox even asserted that call. `createGithubRepo` had no pacing, and on a secondary-limit 403 it simply returned. Every later agent called GitHub again, which keeps the block alive.

**Fail-before**, running main's `github.ts` against a stub:
- a non-production stack made 2 GitHub create calls;
- after a secondary-limit 403 it made 2 more.

## Solution

- **Production only:** `createGithubRepo` creates only when `RENDER=true` (set by Render) or `GITHUB_AGENT_REPOS=on`. Local, benchmark, smoke, coverage, devbox and Fly guest stacks never create.
- **Lazy:** no repo per chat. `ensureAgentTreeRepo` creates the tree's repo on its first Claude Code or Codex session, persists it on the root with a conditional write and grants the owner. Concurrent sessions share one create, and later sessions reuse it. Project-bound trees get none.
- **Paced:** one process-wide pacer spaces creates 7.5 s apart (≤480/h, under GitHub's ~500/h). A create that would wait more than 20 s is skipped, and the session runs repo-less as before. There is no per-user cap.
- **Retry-After:** a 403/429 rate-limit response blocks every create until `Retry-After` (or 60 s); blocked calls never reach GitHub.
- **Idempotent:** a 422 "name already exists" returns the existing repo.

**Regressions:**
- `github-create-repo-fallback` unit test: gate, block, reuse, pacing and the existing token fallback.
- `github-agent-repo` blackbox: lazy, single, persisted and granted create; project trees skipped.
- `agents-boundary` now asserts that a chat agent creates no repo.

**Follow-up 2026-11-06:** the Retry-After block above was wired into `createGithubRepo` only, so every other GitHub call on the code-agent path (merge facts, access check, publish, clone/fetch) still treated a 403/429 as an ordinary answer. The guardrail failed because the lesson was applied at one call site, not at a shared boundary. See `2026-11-06-github-rate-limit-treated-as-ordinary-answer-on-shared-token`, which moves classification, the process-wide block and the bounded wait into `githubRateLimit.ts`.

**At 10,000 agents:** creates scale with trees that run code, not with chats. They are bounded by the global pacer and the account limit, without per-user caps. Beyond ~480/h the remedy is more creation identities (a GitHub App installation), not faster creates.

**Retention, not changed here:** the account holds 50,000 public repos and nothing deletes them. Deleting is destructive, so a retention policy needs Andy's decision. The bulk of these repos are orphans from non-production stacks.

## Human feedback

Andy: no per-user caps of any kind.

## Reusable lesson

Never let test, benchmark or devbox environments share a production credential that carries account-wide rate limits. Create external resources lazily, on first real use. Honour Retry-After globally instead of retrying per request.
