---
id: 2026-10-23-cloud-guest-omitted-claude-code-provider-pin
date: 2026-10-23
title: Cloud benchmark guests omitted the Claude Code provider pin that local runs set, so claude-code-agent ran on Codex
surface: infra
component: cloudbench-task-environment
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloudbench-run.sh resolve_task_gate built the guest TASK_WORKER_ENV without the ROSE_CODE_AGENT_PROVIDER=claude pin that agents/benchmarks/local.py configure_task_environment sets for requires_claude_code / spawn_claude_code_agent tasks
symptoms:
  - "[ClaudeCode] Selected code sandbox provider code_provider=codex compute_token_provider=gpt"
  - "[ComputeCredentials] Serving compute token lease type=gpt source=user"
  - Verifier result score=0.5 The SDK events identify the provider as `codex`
  - "cloud guest TASK_WORKER_ENV missing ROSE_DISABLE_CODE_AGENT_VERIFIER ROSE_DISABLE_API_REQUEST ROSE_DISABLE_GENERAL_PURPOSE_AGENT BROWSER_MAX_ITERATIONS"
  - api_request available to the root in a cloud guest but stripped in local runs
tags:
  - claude-code
  - codex
  - cloudbench
  - local-cloud-parity
  - benchmark-environment
  - descend
sources:
  - benchmark run original600-1792722242636117810
  - fleet run 20261023-024011-28206
  - fleet run 20261023-024011-28259
  - agent b729eca1-ad69-4f30-b566-b605a1e0d4ee
  - agent 84db06af-fab5-4c4e-9b33-74b5a2a77093
  - task claude-code-agent
  - task browser-auth-stale-session-password
  - task browser-auth-account-locked
  - task browser-auth-magic-link
repro: agents/tests/blackbox/benchmark.blackbox.py::test_cloudbench_code_agent_tasks_pin_claude_code_like_local
status: open
---

## Problem

`/descend` run descend-full69-20261023 (sharded `/benchmark full` on
cbbf3dd0c) failed both cloud copies of `claude-code-agent` (job r001-j0001,
agent b729eca1; job r002-j0036, agent 84db06af) with `Timeout after 300s`.
Cluster K4; member task: `claude-code-agent` (both copies). The same task has
10/10 local passes (`descend_outcome_runs.py`: attempts 10, passes 10, runs 5).

Task prompt (unchanged): "Using Claude Code, write and run a Python program
that computes the Collatz sequence starting from 27. Print every number in the
sequence until it reaches 1, and print the total count of steps."

Guest evidence (shard-00 originals.tar.gz, runtime-evidence logs):
backend 02:55:35.153Z `Serving compute token lease type=gpt source=user`;
worker 02:55:46.059Z `[ClaudeCode] Selected code sandbox provider`
`code_provider=codex compute_token_provider=gpt`. The root wrote the code goal
as "Use Claude Code (not Codex) ...". The sub-agent verifier returned 0.5:
"its provider is explicitly codex ... The explicit Claude Code-only requirement
remains unmet". The root re-spawned (2 code spawns in copy 1, 3 in copy 2),
then spawned a browser agent to drive the Claude Code web UI, and the 300s
task budget expired. The user context listed `claude_code` as a connected
integration the whole time.

## Diagnosis

Lease type is not the divergence. Two passing cloud runs of the same task
earlier the same day (fleet runs 20261023-005522-1940486 and
20261023-035139-726239) also leased `type=gpt` and ran `code_provider=codex`;
they passed only because the root paraphrased the goal as "Using Claude Code"
or "(not Codex if selection possible)", and the verifier scored 1.0. The
failing copies wrote a hard "(not Codex)" / "USING CLAUDE CODE" constraint
that a Codex session cannot satisfy. Outcome therefore depended on paraphrase.

Why the session was Codex: `handler.py:_select_code_provider` maps a GPT root
lease to `codex`, and `resolve_code_agent_provider` only overrides that from
`ROSE_CODE_AGENT_PROVIDER`. Locally, `agents/benchmarks/local.py:
configure_task_environment` sets `ROSE_CODE_AGENT_PROVIDER=claude` for every
task that declares `requires_claude_code` or expects `spawn_claude_code_agent`
(the Claude path resolves its own Claude OAuth in-activity via
`_resolve_claude_token_for_activity`, independent of the root lease). Cloud
guests never call `configure_task_environment`: `scripts/cloudbench-run.sh`
starts `run.sh --benchmark` directly and re-derives a subset of task
environment in `resolve_task_gate` (only `NON_PURCHASE_GATES_ENABLED`). The
provider pin was never ported. Guest logs contain no `ROSE_CODE_AGENT_PROVIDER`.

Deepest owned cause (Step 5a): the cloud runner duplicates the local task
environment derivation instead of sharing a source of truth, so local-only
pins silently drift. The fix adds the pin to the shared catalog resolver and
a parity regression that compares cloud and local for every catalog task.
Other local-only flags remain unported in cloud (`ROSE_DISABLE_CODE_AGENT_VERIFIER`,
`ROSE_DISABLE_API_REQUEST`, `ROSE_DISABLE_GENERAL_PURPOSE_AGENT`,
`BROWSER_MAX_ITERATIONS`); they did not cause this failure and are left for
their owning RCA rather than changed blind.

Archive searches: "ROSE_CODE_AGENT_PROVIDER cloud guest local parity
configure_task_environment"; "claude-code-agent codex provider verifier not
Claude Code cloud passes locally"; "cloud guest omitted local task environment
flag Codex silently substituted for Claude Code"; grep for
`ROSE_CODE_AGENT_PROVIDER`. Novel; relative of
2026-09-27-cloud-codex-gate-missed-explicit-local-auth-and-wrapper-selection
(cloud/local configuration drift). Not a recurrence of
2026-10-14-codex-permanent-revocation-feedback-treated-as-exhaustion: the GPT
lease succeeded and no revocation or exhaustion feedback appears.

Local repro (owning boundary): the new blackbox test on b84475d38 fails with
`AssertionError: ['stack:FAST_MODE_CACHE_USE_LOCAL=1',
'stack:FAST_MODE_CACHE_DATABASE_URL=']` (no provider pin); it passes after the
fix, five consecutive times. The exact local benchmark cannot reproduce the
failure because the local runner pins Claude on both revisions; cloud member
reruns supply the outcome proof.

## Solution

`scripts/cloudbench_catalog.py` gains
`selected_tasks_require_claude_code_provider` and a `requires-claude-code`
subcommand with the same predicate as `local.py`. `resolve_task_gate` in
`scripts/cloudbench-run.sh` adds `ROSE_CODE_AGENT_PROVIDER=claude` to
`TASK_WORKER_ENV` (stack and benchmark process) for those tasks and fails
closed on resolver errors. Regression:
`test_cloudbench_code_agent_tasks_pin_claude_code_like_local` in the agents
benchmark blackbox domain asserts the guest export for `claude-code-agent`,
absence for `chat-mode`, and exact cloud/local equality of the pinned set over
the whole catalog. Two existing fake catalog interpreters now answer the new
subcommand. 10k-agent behavior: one extra catalog lookup per guest at launch;
no runtime cost per agent.

Separate product observation, not changed here: with a GPT root lease,
`spawn_claude_code_agent` silently runs Codex while its progress shows
"Connected to Claude Code WebSocket", and the model has no way to request
Claude Code even when the user names it. That is a product/harness question
for its own RCA.

### Recurrence 2026-10-23 (cluster K9): the K4 guardrail held only one flag

K4 ported one flag and its parity test compared only that flag's predicate,
so the same drift remained for every other key `configure_task_environment`
sets. K8's RCA (same run) found `verifier_claude_code` running in the cloud
guest and scoring claude-code-agent copy 1 at 0.5, which locally is disabled
by `ROSE_DISABLE_CODE_AGENT_VERIFIER=1`. Run-1 triage cards for
browser-auth-stale-session-password (r001-j0010), browser-auth-account-locked
(r002-j0050, counts `'api_request': 2`) and browser-auth-magic-link (r001-j0018)
show the root calling `api_request`, which local runs strip with
`ROSE_DISABLE_API_REQUEST=1`. No failed member declares a GP-forbidden tool or
a browser `max_steps`, so `ROSE_DISABLE_GENERAL_PURPOSE_AGENT` and
`BROWSER_MAX_ITERATIONS` changed no run-1 verdict; but 303 catalog tasks
(Polar) declare `max_steps.browser` up to 500, which cloud guests silently
capped at the 250-step default.

Why the earlier fix did not hold: it hand-copied one rule into a second
implementation. Deepest owned cause: two independent derivations of one
per-task worker environment. Fix (Step 6a "unify"): one pure policy,
`scripts/cloudbench_catalog.py:task_worker_environment(tasks, environ)`, which
local `configure_task_environment` applies to `os.environ` and cloud
`resolve_task_gate` exports via the `task-env` subcommand (empty value =
unset). It covers `NON_PURCHASE_GATES_ENABLED`, `ROSE_CODE_AGENT_PROVIDER`,
`ROSE_DISABLE_CODE_AGENT_VERIFIER`, `ROSE_DISABLE_API_REQUEST`,
`ROSE_DISABLE_GENERAL_PURPOSE_AGENT` and `BROWSER_MAX_ITERATIONS`. The K4
`requires-claude-code` subcommand is removed (subsumed). The helper stays the
controller's immutable stdlib-only catalog code, read after exact checkout.

Regression (same test, extended): computes the local env delta of
`configure_task_environment` for every catalog task, requires every non
stack-fixture key to be a shared worker key, runs the real
`cloudbench-run.sh` print path once per distinct local env and requires equal
stack and benchmark exports, then requires the guest helper to resolve every
task identically. Red on 8ada0056f: `AssertionError: {'task':
'test-mass-agent-run-0', 'local': {'ROSE_DISABLE_API_REQUEST': '1',
'ROSE_DISABLE_CODE_AGENT_VERIFIER': '1', 'ROSE_DISABLE_GENERAL_PURPOSE_AGENT':
'0'}, 'cloud': {}}`; green with the fix, 5 consecutive passes (~3s).
Remaining gap: stack-fixture keys are excluded by an explicit list;
`ADMIN_USER_IDS_EXTRA` (admin-bypass task) has no cloud provisioning at all.
Exact local benchmark outcome cannot reproduce (local already had parity);
cloud member reruns supply outcome proof.

Archive searches: "cloud guest local parity configure_task_environment
ROSE_DISABLE_API_REQUEST BROWSER_MAX_ITERATIONS"; "works locally fails in
cloud benchmark guest missing env flag verifier api_request browser step
budget". Verdict: recurrence of this case.

## Human feedback

None recorded.

## Reusable lesson

Derive local and cloud per-task worker environments from one shared policy function, and test that every key local sets reaches the cloud guest unchanged across the whole catalog.
