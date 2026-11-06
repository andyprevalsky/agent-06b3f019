---
id: 2026-11-04-project-resume-kept-stale-credentialed-origin
date: 2026-11-04
title: A resumed project workspace kept the git origin from its first clone, so a rotated GitHub token never reached a paused code session
surface: back-end
component: project-workspace-restore
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/projects/workspace.ts restoreCheckout — existing-workspace branch returned without refreshing origin from the current cloneUrl
symptoms:
  - "Workspace already present; kept its branch and local work"
  - git push fails with authentication error in a resumed project code session
  - "remote: Invalid username or password"
  - code session cannot push after GITHUB_TOKEN rotation
tags:
  - code-agent
  - projects
  - github
  - git-remote
  - token-rotation
  - multi-day
sources:
  - commit 33c5416be6
repro: back-end/src/tests/blackbox/project-workspace.blackbox.ts ("resume re-points origin at the current clone URL")
status: fixed
---

## Problem

A project code session clones with a URL carrying the backend `GITHUB_TOKEN`
(`projects/session.ts` `withGithubToken`). On resume of a paused sandbox,
`restoreCheckout` keeps the existing checkout (correctly) but also kept its
`origin`, so after the token is rotated the session's push and fetch use the
old credential until a fresh clone. The non-project ws-server resume path
(`ws-server.mjs` `RESUMING_REPO`), the snapshot path
(`refreshSnapshotCheckout`) and `maintenanceRunner.ts` already re-set origin.

`bash scripts/run-blackbox-tests.sh project-workspace` on base:
`not ok 6 - resume re-points origin at the current clone URL ...` /
`origin carries the current credentials: /var/tmp/.../rotation-<id>.git`.

## Diagnosis

The existing-workspace branch was written to preserve local work and returned
before any remote refresh; nothing re-applied the credential resolved for this
session. Only a token rotation exposes it (the backend token is static
otherwise), which makes it a multi-day / long-pause failure.

## Solution

On an existing workspace with a `cloneUrl`, `restoreCheckout` runs
`git remote set-url origin <cloneUrl>` (warning, never failing, if it cannot),
matching the snapshot and maintenance paths. Branch, commits and uncommitted
work are untouched; the report never contains the credentialed URL (asserted).
A token rotated while a session is running still reaches it only at its next
resume (open; the backend token is an operator-rotated static secret).
`mergeFacts.ts githubJson` reads `process.env.GITHUB_TOKEN` per call on the
backend, so it needs no fallback (not a bug).

10k agents: one local git command per resume.

## Human feedback

None recorded.

## Reusable lesson

Every path that reuses an existing checkout must re-apply the credential resolved for the current session to its remote.
