---
id: 2026-07-27-plain-coderabbit-review-is-a-noop-on-already-seen-commits
date: 2026-07-27
title: A plain `@coderabbitai review` is a no-op on an already-ingested commit, producing a false-green review gate
surface: harness
component: deploy-pipeline
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: wait-for-code-review trusts the CodeRabbit commit status instead of requiring a review body for the exact HEAD
symptoms:
  - "wait-for-code-review reports CodeRabbit SUCCESS on <sha> with no substantive review"
  - "Review finished. Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits."
  - "Claude fallback returns is_error:true with duration_ms ~2000, num_turns 1, total_cost_usd 0"
tags:
  - coderabbit
  - deploy-pipeline
  - code-review
  - false-green
  - anthropic-credits
sources:
  - memory:project_coderabbit_no_rereview_fallback_gap
repro: none-recorded
status: fixed
---

## Problem

`/deploy` Step 9 passed its review gate on a false green:
`wait-for-code-review` reported `CodeRabbit SUCCESS on <sha>` while no substantive
review existed for that HEAD. The only CodeRabbit output was:

> Review finished. Note: CodeRabbit is an incremental review system and does not
> re-review already reviewed commits.

## Diagnosis

`.coderabbit.yaml` disables review-on-push, so reviews must be requested
explicitly. But a plain `@coderabbitai review` on a commit CodeRabbit has already
ingested is a **no-op** — it still resolves the commit status to success, which the
gate read as a passing review. The gate's contract was wrong: it trusted a commit
status rather than the existence of a review body for the exact HEAD.

The Claude fallback could not rescue the gate either, because Anthropic credits
were exhausted. That failure has an unmistakable signature — the result JSON comes
back `{"type":"result","subtype":"success","is_error":true,"duration_ms":~2000,
"num_turns":1,"total_cost_usd":0}`. ~2s, 1 turn, $0 cost means provider-blocked,
not a repairable workflow bug; a bad checkout or a transient 5xx looks nothing like
this. The credential-health probe independently reported
`Anthropic credits exhausted (HTTP 400)` for the same root cause.

## Solution

Request `@coderabbitai full review`, which forces a re-review of already-seen
commits. Confirm a review body actually exists for the exact HEAD
(`.body | length > 0`, filtered by `commit_id`) instead of trusting the commit
status — exactly as Step 9a warns.

Also note the contract boundary: the deploy contract's skippable-review clause
requires **both** reviewers to be _usage-exhausted_. CodeRabbit declining to
re-review is not usage exhaustion, so that clause does not apply and the review
cannot be skipped — force the full review instead.

## Human feedback

None recorded.

## Reusable lesson

Never accept a review-gate commit status as proof of review — require a non-empty
review body for the exact HEAD, and use `@coderabbitai full review` since a plain
`review` is a no-op on seen commits.
