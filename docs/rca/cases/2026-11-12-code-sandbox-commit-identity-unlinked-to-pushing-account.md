---
id: 2026-11-12-code-sandbox-commit-identity-unlinked-to-pushing-account
date: 2026-11-12
title: Code sandboxes committed as an address no GitHub account owns, so Vercel blocked every agent-authored main HEAD
surface: cross
component: code-sandbox-git-identity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/*/ws-server.mjs (clone) and codeSessions/checkpoint.ts (restore) configured git as `Rose Agent <agent@roselabs.ai>`, an identity unrelated to the GITHUB_TOKEN account that pushes
symptoms:
  - "Deployment was blocked"
  - "GitHub couldn’t verify an account for the commit."
  - "Git author rose-agent must have access to the project on Vercel to create deployments."
  - roselabs.ai/version.json buildId stuck on d27550bc957c while main moved ahead
  - GitHub commit API author null for agent@roselabs.ai commits
tags:
  - vercel
  - git-identity
  - code-agent
  - e2b
  - deploy-blocked
sources:
  - PR #1983
  - commit f43345a18484
  - commit 5fadc988b
  - commit 9c96baf75
  - commit 485c74165
  - memory:vercel-blocks-unlinked-commit-author
repro: back-end/src/tests/unit/ws-server-git-identity.test.ts
status: fixed
---

## Problem

From 2026-11-12 about 03:09Z, every `main` HEAD commit authored by a Rose code
agent, `Rose Agent <agent@roselabs.ai>`, received the Vercel commit statuses
"GitHub couldn’t verify an account for the commit." and "Deployment was
blocked". Production front-end stayed on buildId `d27550bc957c` while main moved
ahead; mobile CPU round 1 (`49d8d36f3`) and later work were not live until a
devbox-authored merge commit reached HEAD.

## Diagnosis

Vercel builds a pushed commit only when two things hold. First, GitHub must
associate the commit's author email with a GitHub account. Second, that account
must have access to the Vercel project.

The GitHub commit API on `Rose-Ai-Labs/rose` showed both failure modes:

| Commit | Author email | GitHub `author` | Vercel status |
| --- | --- | --- | --- |
| `5fadc988b`, `a2e8ded4c`, `739812fe6`, and code-agent commits back to 11-12 00:09Z | `agent@roselabs.ai` | `null` | "GitHub couldn’t verify an account for the commit." |
| `9c96baf75` (11-11 23:51Z, an agent-chosen identity) | `rose-agent@users.noreply.github.com` | `rose-agent`, an unrelated account | "Git author rose-agent must have access to the project on Vercel to create deployments." |
| `485c74165` | `andyprevalsky@yahoo.com` | `andyprevalsky`, a Vercel member | deployed |

Apart from the author, Vercel builds every main commit, records-only commits
included.

The identity was hard-coded where code sandboxes configure git:
`e2b-templates/claude-code/ws-server.mjs` and
`e2b-templates/codex-code/ws-server.mjs` on clone, and the checkpoint restore
fallback in `back-end/src/providers/codeSessions/checkpoint.ts`. The sandboxes
push with the backend `GITHUB_TOKEN`, which belongs to GitHub user
`andyprevalsky` (id 25310436). The identity on the commits was therefore not the
account that pushed them, and no account at all as far as GitHub could tell.
The hard-coded identity dates from `8af1121ce2` (2026-01-20). It surfaced on
11-11/12 because code agents began pushing straight to main instead of to
branches that a devbox merged.

Local repro: `cd back-end && npx tsx src/tests/unit/ws-server-git-identity.test.ts`
runs the real Claude and Codex ws-servers with real git: a fresh clone, a
resumed workspace and a project workspace, for each server. With the
`origin/main` servers (`15e89bf4eb`) it fails 6/6, because the repos are
configured as `Rose Agent <agent@roselabs.ai>`. With the fix it passes 6/6.

A second gap explains why such a fix could miss sandboxes. The backend overlays
`../e2b-templates/*/ws-server.mjs` from its Render checkout into every sandbox.
The production log reads "Overlayed Claude Code ws-server from
/opt/render/project/src/e2b-templates/claude-code/ws-server.mjs". The Render
service's root directory is `back-end` with no build filter, so a commit that
changes only `e2b-templates/` never triggers a backend deploy.

## Solution

`back-end/src/providers/codeAgentGitIdentity.ts` resolves the account behind the
pushing token with `GET /user`, once per token per process. It builds that
account's GitHub no-reply address, `<id>+<login>@users.noreply.github.com`.
Both cloud spawn paths in `e2b.ts` (Claude Code and Codex, for repository and
project sessions) give the sandbox `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. Git
prefers these over repo config, so neither a template-baked ws-server nor a
restored checkout can override them. The ws-servers mirror the identity into the
repo on clone, resume and project start. Checkpoint restore no longer writes the
unlinkable fallback.

Two edge cases are covered. When REST core quota is exhausted, the same token
resolves through GraphQL `viewer`, which has a separate quota. On 2026-11-12 the
shared primary token was at 0/5000 REST with GraphQL 4976 left. Only github.com
repositories get an identity. If the account cannot be resolved at all, the
spawn fails instead of committing under an identity that would land but never
deploy.

A Claude CLI still running from before the fix would keep its old environment.
The four identity keys therefore join the live-attach credential digest, so the
ws-server refuses that CLI (`credential_changed`) and the backend restarts it
with the identity. Checkpoint restore records the env identity. It keeps a
local-only default for sandboxes that never push, such as inspections, which
restore without credentials. The Render service now has the
build filter `back-end/**` and `e2b-templates/**`.

Merged as `f43345a18484` (PR #1983) after a full gate round on `fc38b4cd76`.
Regressions on the deploy path (backend unit/coverage run):
`code-agent-git-identity.test.ts` (10 cases) and
`ws-server-git-identity.test.ts` (6 cases). The
latter wraps `e2b-templates/claude-code/git-identity.test.mjs`.

Open items:
- Nothing on the push or merge path to main checks the author. An agent can
  still pass `--author` or export its own identity, as `9c96baf75`
  (`rose-agent`) did. Devbox sessions also landed unlinked identities:
  `deploy@roselabs.ai` on 11-06 and `codex@openai.com`.
- The fix is only correct while the account behind `GITHUB_TOKEN` is a member
  of the Vercel project. That holds today (`andyprevalsky`); switching the
  token to a machine account or App would block deploys again.
- Render's documentation does not say whether a build-filter include outside
  the root directory triggers a deploy. This was unverified when the filter
  was set.

## Human feedback

Andy (2026-11-12): "fix the issues w why they couldn't get to main in the first
place (specifically the vercel issue)". He required proof on a real commit, a
regression in the deploy path, the fix reaching production sandboxes, and a
later Rose code-agent commit on main auto-deploying.

## Reusable lesson

Commit as the account whose credential pushes: an identity no external system
can link makes downstream deploy gates refuse the work silently.
