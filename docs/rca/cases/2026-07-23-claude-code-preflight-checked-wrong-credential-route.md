---
id: 2026-07-23-claude-code-preflight-checked-wrong-credential-route
date: 2026-07-23
title: The Claude Code smoke preflight validated a generic compute token instead of the dedicated runtime credential route, admitting a doomed five-minute retry loop
surface: harness
component: claude-code-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the Claude Code smoke preflight — it accepted a generic compute token rather than probing the dedicated credential route that runtime session creation actually uses
symptoms:
  - claude-code smoke task burns a five-minute retry loop before failing
  - preflight passes but the Claude Code session never authenticates
  - "no usable synced credential" only discovered at runtime, not at dispatch
tags:
  - claude-code
  - smoke-benchmark
  - preflight
  - credentials
  - retry-loop
sources:
  - PR #856
repro: agents blackbox — the two dedicated Claude Code preflight regressions
status: fixed
---

## Problem

The `claude-code-agent` smoke task could pass its credential preflight and then
spend a doomed five-minute retry loop at runtime, because the credential it was
launched with could not create a Claude Code session at all. The failure was
expensive (a full retry budget) and late (after dispatch), and it repeatedly showed
up as an unexplained smoke failure rather than as a missing credential.

## Diagnosis

Preflight and runtime consulted _different_ credential surfaces. The preflight was
satisfied by the presence of a generic compute token, while runtime session
creation requires the dedicated Claude Code credential route. Any state where a
generic token exists but no dedicated synced credential does therefore passed the
gate and failed the work — the preflight was not a predicate over the thing that
had to succeed. The deepest owned cause is a contract inconsistency between the
check and the operation it claims to guard.

## Solution

The Claude Code smoke preflight now checks the same dedicated credential route
that runtime session creation uses, so a generic compute token can no longer admit
a run that cannot possibly authenticate; the task is skipped at dispatch instead,
with no agent launched and no retry budget burned. Cemented by two dedicated Claude
Code preflight regressions in the agents blackbox matrix (88 domains passing, 80%
coverage) alongside 36 compute-preflight tests. Verified in the final smoke run:
Claude Code was skipped at dispatch because the dedicated runtime credential route
proved no usable synced credential.

## Human feedback

The maintainer sanctioned the Claude Code smoke skip for this deploy (recorded as
"1 sanctioned Claude credential skip" against 5/5 runnable tasks passing) rather
than letting the task run without a usable dedicated credential. The maintainer
also explicitly authorized merging PR #856 without a separate GitHub `APPROVED`
review, as the PR was authored by the sole maintainer's own account and GitHub
forbids self-review — a narrow override scoped to this PR only.

## Reusable lesson

A credential preflight must probe the exact route the runtime will use — checking a
sibling credential surface converts a missing-credential condition into a full
retry-budget timeout.


### October 27 recurrence: deploy-token scope versus provider-neutral fallback

Smoke run `ca786f36-7806-423b-a358-1910ede72137`, root
`1b5b551e-803c-4b9a-8f70-2f0d39567479`, failed after303s under its unchanged
300s limit. The goal explicitly requested Claude Code for the Collatz sequence
from27. Runtime had no leasable Claude credential and correctly used its
existing Codex fallback, which computed111 steps and112 terms; the root then
tried Claude Web to satisfy the requested tool. Preflight had admitted the
Claude-specific deploy task from OpenRouter configuration, even though the
standing deploy skip requires an own/pool Claude token. This repeats the
credential-surface inconsistency, not a demonstrated sandbox transport defect.

Only with existing `BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP=1` does the
preflight now treat the existing user/pool token route as authoritative:
nonempty token200 qualifies, actual404 proves absence, malformed200/auth/server/
network errors remain failures. Default funded fallback outside this opt-in
mode is unchanged. Dispatch also refuses to silently skip without the flag.
There is no new endpoint, benchmark criterion, timeout or waiver.

Four identical source-overlay owning tests passed one/failed three before and
passed four after; wall-clock timing for this private pair was not recorded.
They cover own/pool tokens,404 despite shared fallback, malformed200/401/500/
network errors, default Anthropic/OpenRouter fallback and opt-in-only dispatch.
The tests are registered in the normal benchmark domain and compute-preflight
unit suite. All121 agent domains,214 DEMO and172 unit tests subsequently passed
under84% combined coverage at source29e2c47e3. Golden N3392r4 grounds the
mandatory harness hunks. The original task failure remains unchanged; actual
post-fix smoke admission/skip and full-model acceptance are still pending.
Archive search also found2026-10-01-codex-credit-skip-masked-oauth-revocation:
only typed evidence may authorize an existing skip, never an unknown error.
