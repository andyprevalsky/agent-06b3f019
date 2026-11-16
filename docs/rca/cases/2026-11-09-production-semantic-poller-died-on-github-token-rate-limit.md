---
id: 2026-11-09-production-semantic-poller-died-on-github-token-rate-limit
date: 2026-11-09
title: Production semantic lane failed a still-running workflow because its read-only GitHub polls used the exhausted primary token
surface: infra
component: deploy-production
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run_deploy_pipeline.py _gh_text (every gh call, reads included, inherited the deploy's one GH_TOKEN); scripts/deploy_prod.py Ctx.gh_json and mac_watch (same for PR-label, Vercel deployments and Mac-release reads)
symptoms:
  - "[semantic] PIPELINE_SEMANTIC status=blocked exit=1 gh run view 42668217644 failed: HTTP 403: API rate limit exceeded for user ID 25310436"
  - "DEPLOY_PRODUCTION FAIL sha=cd0d894d03f5 failed=semantic"
  - "mac-release: cannot decide the Mac release: MAC-APP-RELEASE label unknown (gh api repos/{owner}/{repo}/commits/<sha>/pulls failed: gh: API rate limit exceeded for user ID 25310436"
tags:
  - deploy-production
  - github-rate-limit
  - github-token-pool
  - production-semantic
sources:
  - PR #1872
  - PR #1901
  - commit 4074a41c98e1c8a970a5de68fd1f75d9bd02afa1
  - PR #2094 (merge 2ac670e4d6, observer handoff)
  - commit 510655ee55f6e9be3b2ac3dcd33711468526fdea
  - plan:/project/devbox-closeouts/semantic-poller-rate-limit-20261109/ (main-run2.log, production.json; GitHub run 42668217644)
  - plan:devbox-closeout-private/pr1901/20261115T033950Z-records.tar.gz.aesgcm (docs/handoffs/pr-1901-closeout/private-archive-receipt.json)
repro: scripts/tests/run-deploy-pipeline.test.py (production semantic case 15); scripts/tests/deploy-prod.test.py (OtherLanesTest token-pool cases)
status: fixed
---

## Problem

`scripts/deploy production --sha cd0d894d03f5` (main 510655ee5, devbox
445ef57c, 2026-11-09 17:48Z) dispatched `chat-lifecycle-ratchet.yml` run
42668217644 and polled it with `gh run view --json`. At 17:55:33Z the poll
returned `HTTP 403: API rate limit exceeded for user ID 25310436`. The lane
recorded `status=blocked exit=1` and the whole production verification
failed, while the workflow was still `in_progress` with 3/5 jobs green. At the
same time `scripts/github_token_pool.py status` showed GITHUB_TOKEN core
0/5000 (reset 18:16:29Z) and GITHUB_APP 5000/5000, which read the run.

## Diagnosis

1. `_gh_text` ran every gh call with the inherited environment. deploy.md
   Step 13b sets `GH_TOKEN` to back-end/.env `GITHUB_TOKEN` because the
   dispatch needs a workflow-scoped identity. Reads therefore spent the same
   5,000/h core quota that every other thread of this user drains.
2. CLAUDE.md "GitHub token pool" already directs read-only calls to the
   member with the most quota left. The production lanes predated that and
   never used it.
3. The same pattern in `deploy_prod.Ctx.gh_json` failed the mac-release
   label read when the original command was rerun with the token still at 0.

## Repro

Before the fix, the new production-semantic case 15 failed with the
production message (`gh run list --workflow failed: HTTP 403: API rate limit
exceeded for user ID 25310436.`). The new deploy-prod label test failed with
`MAC-APP-RELEASE label unknown (gh pr view failed: HTTP 403: API rate limit
exceeded ...)`. Both pass on the fix.

The original command was rerun on a copy of the failed receipt at
2026-11-09 18:06Z on devbox 763eae56, with GITHUB_TOKEN core = 0/5000. It
resumed run 42668217644 and ended
`DEPLOY_PRODUCTION PASS sha=cd0d894d03f5 lanes=render:PASS-verified-by-descendant,backend-probes:PASS,semantic:PASS`.
Evidence: /project/devbox-closeouts/semantic-poller-rate-limit-20261109/repair-763eae56/.

## Solution

Read-only gh calls (`run list`, `run view --json`, `run view --log`, and
`deploy_prod` `gh_json`) use `github_token_pool.py pick --resource core`. If
that member fails, the call is retried once with `GH_TOKEN`, because a 404
from the App or a machine account is not authoritative. Dispatch and rerun
keep `GH_TOKEN`. With no usable pool member, reads behave exactly as before.
Assertions, timeouts, poll cadence and the workflow PASS/FAIL semantics are
unchanged.

## Observer extension (2026-11-14, PR2094 handoff)

On merge 2ac670e4d6 (PR #2094), the production observer failed Vercel (90x10s) and mac-release (60x10s) on the same 403 while the merge was live: GraphQL showed Vercel Production SUCCESS at 21:49:14Z. The pooled REST read did not help Vercel. The only other pool member, the GitHub App, has no Deployments permission ("Resource not accessible by integration"), and the fallback to GH_TOKEN was exhausted. The Vercel lane now reads the same deployments and their latest status through GraphQL, which has a separate quota, only when REST is rate limited. GraphQL names the bot `vercel`, not `vercel[bot]`, and returns uppercase states. The `gh run watch` for mac-release streams with the pool's read token, passed as hidden env so it never appears in a displayed or recorded command. Live proof, 2026-11-15 02:59Z, from merge 4074a41c98 with GITHUB_TOKEN core 0: `scripts/deploy production --sha 2ac670e4d6 --lanes vercel,mac-release` gave vercel PASS (deployment 7794378974, via GraphQL) and mac-release PASS (run 43644361271).

Dispatch (`gh workflow run`) is a write and stays on GITHUB_TOKEN. With that token at 0, production-semantic still cannot dispatch; it fails before any run exists, and a rerun after the reset dispatches once. No pool member can dispatch workflows.

## Human feedback

None recorded for the fix itself. During the deploy, the smoke coordinator relayed Andy's 2026-11-15 instructions to retire the serial smoke queue (01:56Z "there should never be any serialization here ever"). It also relayed his instructions to run AgentCard tasks only when AgentCard infra changes (01:57:29Z) and to "skip agent card tests" (02:13:52Z). This deploy's smoke had launched by then with the AgentCard tasks included and passed them, so the run was not restarted.

## Reusable lesson

Every read-only GitHub call in deploy tooling must take the token pool's pick, and fall back to a separate-quota path such as GraphQL, rather than the single primary identity. Other threads drain that identity's 5,000/h core quota within minutes of each reset. Writes such as dispatch, rerun, merge and PR edits must stay on GITHUB_TOKEN, so plan those for just after the reset.

## 10k-agent behavior

This is deploy tooling, not a per-agent path. Each read adds one
`/rate_limit` probe per pool member, and those probes do not count against
the quota. Nothing in it scales with agent count.
