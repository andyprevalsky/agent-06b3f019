---
id: 2026-11-06-code-agent-sandbox-promised-gh-but-never-installed
date: 2026-11-06
title: The code-agent sandbox templates never installed gh although a tool description promised it
surface: infra
component: e2b-templates
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/{claude-code,codex-code}/e2b.Dockerfile installed git but not gh, while agents/tools/prompts/web_fetch.py:11 told the planner "the sandbox already has gh installed"
symptoms:
  - gh isn't installed in this sandbox
  - bash: gh: command not found
  - the sandbox already has gh installed
tags:
  - e2b
  - sandbox-template
  - gh
  - code-agent
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82 code task 6f8f8f4d-c670-4bc8-b5df-e2c785c4a908 (prod "Rose Repo Status": the code agent reported gh missing and fell back to the REST API with the remote credential)
repro: back-end/src/tests/structural/sandbox-size-templates.test.ts
status: fixed
---

## Problem

A prod Rose-on-Rose code agent asked to count open PRs and issues found `gh`
missing ("gh isn't installed in this sandbox") and fell back to paging the GitHub
REST API by hand with the token from the git remote. The web_fetch tool
description told the planner to prefer a code agent for GitHub work because
"the sandbox already has gh installed". Andy expected gh to be there.

## Diagnosis

Probe (E2B, 2026-11-06): a fresh sandbox from each current template
(`claude-code-c2-m4`, `claude-code-v21305-c2-m4`, `codex-code-c2-m4`,
`codex-code-v0159`) reports `command -v gh` empty; both Dockerfiles install
git, curl, nodejs, python and Playwright but never gh. The claim in the tool
description had no check behind it and nothing in the build verified the tools
the prompts promise.

## Solution

Both Dockerfiles install gh from GitHub's own signed apt repository (keyring +
`signed-by` source, same RUN layer, apt lists cleaned, `gh --version` at build
time). No credential is baked in: gh reads GITHUB_TOKEN / GH_TOKEN from the
session environment. The sized-template verify step now also requires
`gh --version`. `sandbox-size-templates.test.ts` (backend structural lane)
pins: the official repo + keyring, no piped installer, lists cleaned in the same
RUN, no credential ENV/ARG, and a template without gh fails the build run and
withholds the grid go-ahead. Mutation-checked.

New and rebuilt sandboxes get gh only after the production templates are
rebuilt (`build-sized-templates.mjs --execute --via sdk`); paused sandboxes and
sessions started from a project template snapshot keep their old image until
they are recreated or the snapshot is republished. Template cost at 10k agents:
one image, no per-agent work.

## Human feedback

Andy asked why the sandbox does not already have gh, which kept the tool
description's claim and installed the tool instead of deleting the claim.

## Reusable lesson

When a tool description or prompt promises a binary in the sandbox, the
template build must verify that binary, or the promise will silently be false.
