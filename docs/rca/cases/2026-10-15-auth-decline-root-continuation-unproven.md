---
id: 2026-10-15-auth-decline-root-continuation-unproven
date: 2026-10-15
title: Root continued public inspection after declined authentication; causal proof remains open
surface: agents
component: root-execute-decision
classification: unresolved
problem_class: other
first_bad_boundary: Observed execute_loop output 10bac80a4518 requested another browser; owning cause unproven
symptoms:
  - "Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2"
  - browser-auth-assistance-declined
  - User declined to sign in
  - agent status ACTIVE, expected COMPLETED
tags:
  - browser-auth
  - user-decision
  - root-continuation
sources:
  - agent 35e19e7d-ed3a-4b31-bf19-b0938723f3fa
  - commit e7ec9ddb076bcfe6f38bd357bd8bad94a3eda379
  - commit fc4f6d94856df7ee7c5558015e7cb18549471431
  - benchmark run 1792091298-3834360-72062
  - agent 84dd7f40-7f23-4617-8371-2c7af19b9d29
  - benchmark run 1792093233-208216-94509
repro: none-recorded
status: open
---

## Problem

Unchanged predeploy task failed after 318.9 seconds because root browser dispatch count reached two, root still ACTIVE at evaluation. Original run 1792091298-3834360-72062, Hub bundle f892be3b-10b4-421e-bdd5-97a8534a6441, surface e6544bfcb692. Later completion does not repair that failed snapshot. Private original logs, dumps, identities and hashes are preserved under /home/boxes/rose/.context/auth-decline-evidence. Three existing summaries ran in parallel against this exact root. agent_logs counts persisted progress/status messages, not benchmark root dispatches.

## Diagnosis

Observed UTC chain: first browser call_U3AmWbnifuiMfkPzSR30IdaD dispatched 19:12:43.509277. Denial ended task 8fb423a9-8ce2-5930-8b5d-720c4b20883d at 19:17:01.031621. Root then dispatched explore at 19:17:06.078528 and 19:17:26.163853. Captured execute_loop 10bac80a4518 requested unauthenticated inspection, expressly forbidding authentication/bypass. Its distinct second browser call_F7VPdMpoUakKHk9GJACMRhq9 dispatched 19:17:43.815782, span d346d760a8c2 under 64de6539ab10, completing 19:18:21.955355. Distinct model calls and dispatch spans rule out duplicate persistence alone; they do not prove incorrect denial resume.

The model received the denial text and already-approved EXECUTE refusal rule fc4f6d948. Browser manager maps the rejection sentinel into AUTH_ASSISTANCE_DECLINED, closes the session, and emits FINISHED/authAssistanceDeclined=true. Both existing owning tests passed unchanged in 2.8765 seconds. No ordinary-code defect or failing/passing causal regression has been established.

Archive searches used literal error and behavior vocabulary: exceeded its exact root call limit; browser authentication assistance declined resume. No archive case established this cause. Git history found the symptom in fc4f6d948, c05f6fa35 and 4b12ac96d; the latter removed steering text per review. This is symptom recurrence after a prior prompt fix, cause unresolved. Relevant open PRs 1519 and 1511 were inspected; neither was adopted as a proven repair.

A complete captured decision replay through RoseClient.complete held messages/tools/config fixed, verified regenerated AgentAction tools equal captured tools, and observed the same gpt-6-sol-foundry route. In 4.9091 seconds it chose another public-data explore rather than the original second browser. This retains a nondeterministic reproduction gap; it is not model-intelligence proof. No model upgrade comparison occurred. Trace upload to the unavailable local backend failed; local request/result survive privately.

Exact unchanged baseline command bash scripts/run-bench --local browser-auth-assistance-declined ran from exact e7ec9ddb in isolated repair worktree. An initial missing TEMPORAL_TASK_QUEUE configuration failure before services is retained. Run 1792092209-4120978-50353 then bootstrapped its exact-owned DB/frontend, but worker launcher exited because agents/.env was absent despite values supplied in process environment. No task agent started: infrastructure failure, no benchmark red/green. User forbids env/secret writes, so no env file was created.

## Solution

No runtime fix implemented. A private exact-diff policy proposal is in /home/boxes/rose/.context/auth-decline-evidence/proposed-boundary.diff for parent consideration, not a proven or approval-ready repair. Deterministic causal red/green and exact unchanged-task outcome proof remain outstanding. Implementing visible policy/terminal changes requires the parent's approval workflow.

Abstraction climb: continued pursuit after declined prerequisite generalizes coherently to required-step denial completion policy. Automatically terminating every root on any declined optional substep is incoherent: independently authorized completion may remain possible. The proposal clarifies the former, with constant prompt cost and no runtime state/polls/shared resources at 10k agents. Future regression design must cover both blocked-required and optional-decline cases without keyword classification.

Golden reference inspected: claude-code-src/src/constants/prompts.ts:189 prohibits repeating an exact denied call but permits adjusting approach. Existing Rose wording converges; the proposed blocked-goal clarification goes beyond it and needs a product decision. Searches in codex/codex-rs/core/gpt-5.2-codex_prompt.md, openclaw/src/agents/system-prompt.ts and hermes-agent/run_agent.py established no equivalent blocked-goal terminal policy.

Owned baseline controller/stack and all four manifest service PIDs are absent. PostgreSQL catalog confirms its exact database absent; services manifest says stopped. Native receipt remains state=failed after worker exit 1; never rewritten as clean. Benchmark owner says not_started; no task/provider browser was created. All artifacts/worktree/ref retained. Parent resources untouched. Latency diagnostic default incidentally appended 4489 span records in active checkout; shared history retained rather than overwritten and parent progress discloses this side effect. Future calls must use --no-record-span-history.

### 2026-10-15 authorized unchanged baseline continuation

The parent clarified that existing authoritative env symlinks are authorized isolated setup. All three worktree env links now point read-only to verified regular authoritative files under /home/boxes/rose; targets were never changed. HOME/home/CODEX_HOME were excluded from config assignment. Standard original smoke fixture names were FAST_MODE_CACHE_USE_LOCAL, BENCHMARK_FAST_MODE_CACHE, BENCHMARK_SKIP_WMH_BUILD, BENCHMARK_ATTEMPT_SUITE and BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY; FAST_MODE_CACHE_DATABASE_URL was unset. The existing codex-fresh-fixture-env.sh was sourced read-only for CODEX_AUTH_PATH, CODEX_TOKEN_USER_ID, CODEX_BLACKBOX_USER_ID and BACKEND_CODEX_TOKEN_SYNC_SKIP. No compute-lane pin was added. Normal current compute-token and local Codex sync ran. Variable names, not their values, are documented privately.

The parent latency marker retired at 19:40:14.244549 UTC. Exactly one further baseline launched at 19:40:33.510691 UTC: bash scripts/run-bench --local browser-auth-assistance-declined. Source before and after is e7ec9ddb076bcfe6f38bd357bd8bad94a3eda379, with no runtime source edits. Task definition/evaluators/fixtures/bounds are unchanged. Run 1792093233-208216-94509, Hub bundle a5017636-42c4-4f88-91bc-6ae950d4dec5, root 84dd7f40-7f23-4617-8371-2c7af19b9d29. Native task result PASS/COMPLETED, 315.7 seconds; native report elapsed 326.6 seconds. All three declared evaluators passed; one assistance request was triggered/resolved. Owning counter reported browser=1, explore spawn_agent=1, grep=4, attempt_completion=1. After denial, the root explored available records and reported the sign-in limitation. This is an unchanged passing baseline, not red/green repair proof, and no reroll was launched.

Native recorded cost is 6 cents, 98 messages, 34 LLM calls, 89.0% prompt cache. Billing coverage is incomplete: provider subscription, infrastructure, browser-provider and all Azure charges are not established by this native task cost. The refreshed baseline used the Codex token path, while the original captured root decision used Foundry; no provider/model causal claim follows from this uncontrolled difference. Independent audit supplied by the parent agrees denial propagated correctly, the original second browser only read public content then completed, and no ordinary-code repair is proven.

Controller 208216 exited 0; stack owner 208341 and benchmark owner 224449 retired. Both native receipts are clean, manifest stopped, every exact recorded PID and run-environment process absent, and exact local database absent. Native Kernel session receipt is terminal 404; root sealed/deleted through native finalization, no purchases. Previous startup failures and original failed root remain separate and intact. All run logs/dumps/results and SHA256 manifests are preserved privately under auth-decline-evidence/authoritative-baseline-preserved.

Publication used canonical scripts/publish_evidence_links.py against this immutable run.json. Exact durable Hub GET 200 with matching bundle ID preceded --skip-hub-upload. No FE verification was skipped. Full-tree JSON identity filtering and numeric filename-time selection chose 1792093615361-bacd3119296e-benchmark_declared_evaluator.json, SHA256 28dc4b834f455a99a65e28c7235d0262e167cf535676ef576ed7c9d647ec2525. Canonical fresh-browser visible transcript and every browser terminal/recording check passed. Additional HTTPS GETs for FE and rendered dump returned 200 text/html. Signed links, manifest, selection candidates/hashes and publication receipt are private under auth-decline-evidence/published-artifacts and publication-receipt.private.json.

The original failure remains unreproduced and this case stays open. No causal deterministic red/green or repaired benchmark exists. The prior private prompt diff is an unimplemented investigative draft, not a proven necessary repair or an approval request. Parent owns gate exception decisions, integration and original group publication. No new model call, benchmark, prompt implementation, push, merge or deploy followed the single baseline.

## Human feedback

Use current thread without children; preserve Freedom/devboxes/refs/evidence and parent resources. Parent owns deployment/human approvals/controllers. No secret/env writes, vendor communications, live cards, purchase retry, production writes, prompt/context/terminal/schema implementation before parent proposal, benchmark bounds changes, push/merge/deploy. Exact unchanged-task proof cannot be replaced by proxy tests.

## Reusable lesson

Correlate captured model call IDs with dispatch spans before blaming replay or changing refusal completion policy.
