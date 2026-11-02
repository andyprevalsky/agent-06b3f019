---
id: 2026-10-26-chat-workspace-repository-hit-github-secondary-content-limit
date: 2026-10-26
title: Chat workspace repository creation hit GitHub secondary content limit
surface: back-end
component: github-workspace-provisioning
classification: third-party-failure
problem_class: other
first_bad_boundary: GitHub user repos POST returned a secondary content creation rate limit
symptoms:
  - Chat agent creation returned HTTP 201 while auxiliary repository creation returned HTTP 403
  - GitHub reported a temporary secondary content creation block
tags:
  - github
  - secondary-rate-limit
  - workspace
  - auxiliary-provisioning
sources:
  - commit 646ee1bab18145f519306376014282bcfadea99d
  - plan:.context/rca-workspace403-readonly/findings.txt
repro: none-recorded
status: open
---

## Problem

The final local smoke run logged a GitHub HTTP403 at 21:46:26.048Z on
October26 while creating repository agent-e72ae0af. GitHub explicitly reported
a secondary content-creation rate limit. Repository recovery is unproven.

## Diagnosis

Incoming POST /api/agents request9e87052f7059 returned201 for chat agent
e72ae0af-a3c9-4cbe-900f-91a69da34c5c. Its asynchronous startChatMode path
called createGithubRepo, which POSTed to /user/repos, logged403 and returned
null. Retained provider request84F6:ACBE0:55B12:78045:6ADFCA31 is dated
21:46:25UTC. Native evidence is logs/backend.log lines26096 and26163 in
.context/benchmarks/1793050321-4012357-70240; safe attribution is retained
under .context/rca-workspace403-readonly.

The chat-mode task passed in13.0s because its evaluator requires an assistant
response, without a repository-creation assertion. That result does not prove
workspace provisioning succeeded. This was not an established negative control.
Archive searches found no exact recurrence; older stale401 and wrong-capture
cases concern different boundaries. No credential or request-burst cause is
inferred beyond the explicit provider response.

## Solution

No runtime repair or causal red/green reproduction is claimed. Investigation
used existing source and logs only. No provider query, repository retry,
credential change or cleanup action was performed. Keep auxiliary repository
recovery open without relabeling the accepted chat response as a failure.

## Human feedback

The coordinating agent requested bounded read-only attribution while required
deployment checks ran. The user supplied no provider-limit waiver or recovery
claim.

## Reusable lesson

Track auxiliary provisioning separately from the operation that started it;
a successful chat response does not certify workspace repository creation.
