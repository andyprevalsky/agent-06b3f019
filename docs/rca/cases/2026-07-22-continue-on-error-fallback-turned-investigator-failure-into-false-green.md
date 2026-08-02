---
id: 2026-07-22-continue-on-error-fallback-turned-investigator-failure-into-false-green
date: 2026-07-22
title: continue-on-error plus a generic PR fallback turned a 1.25s investigator crash into a successful workflow with an empty RCA draft
surface: infra
component: auto-rca-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the Auto-RCA workflow — `continue-on-error` on the investigator step plus the generic PR fallback let a failed investigation report success
symptoms:
  - Auto-RCA workflow reports success after the investigator errors in 1.25 seconds
  - empty RCA draft PR opened with no findings
  - failed investigation produces a green workflow run
tags:
  - auto-rca
  - false-green
  - continue-on-error
  - lifecycle-gate
  - fail-closed
sources:
  - PR #849
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production Auto-RCA run `29808863373` returned an investigator error after just
1.25 seconds. Because the step was marked `continue-on-error` and a generic PR
fallback then ran, the workflow reported **success** and produced empty draft PR
#836 — an RCA that had done no investigation at all, presented as a completed one.

## Diagnosis

The lifecycle had no fail-closed boundary between "the investigator ran" and "the
artifacts are complete". `continue-on-error` suppressed the only signal that the
investigation had failed, and the generic fallback then satisfied the workflow's
sole remaining success condition — that a PR exists. So the presence of an artifact
was accepted as proof of work, with nothing verifying reproduction, evidence, or
that the attestations belonged to the verified HEAD. The deepest owned cause is
that readiness was inferred from workflow mechanics rather than asserted from
trusted evidence.

## Solution

Readiness now requires trusted evidence: an unchanged baseline-fail/current-pass
reproduction and HEAD-scoped attestations before a draft can be marked ready, with
production/GitHub/Slack credentials kept outside the investigator process so the
agent cannot forge its own gates. One deterministic PR plus Slack card per affected
agent, serialized reviewer feedback accepted via a top-level `/rca <requested
changes>` PR comment, reconciliation of interrupted transitions, Slack rate-limit
retries, and dispatch-first Python/TypeScript emitters so duplicate dispatches are
true no-ops and retries cannot duplicate Slack cards. The lifecycle blackbox test
reproduces the false-green boundary and proves the trusted finalizer now keeps
incomplete work red, draft, and blocked.

## Human feedback

The prompt snapshot carried explicit human approval. The maintainer required the
production canary proof of the PR/Slack-card lifecycle to run _after_ merge, since
repository-dispatch workflows execute from the default branch. Pre-deploy smoke was
5/6 with `claude-code-agent` explicitly waived by the repository administrator
after its external Claude Code account returned `Credit balance is too low`.

## Reusable lesson

Never let `continue-on-error` plus a fallback artifact define success — gate
readiness on trusted, HEAD-scoped evidence of reproduction so a failed run stays
red instead of shipping an empty result.
