---
id: 2026-10-14-attention-replies-trusted-caller-targets
date: 2026-10-14
title: Attention replies trusted caller-selected agent and workflow targets
surface: back-end
component: attention request ownership and durable input delivery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Attention request creation accepted caller-selected userId, agentId and workflowId without authenticating the caller or binding the targets to that identity
symptoms:
  - An own-account JWT could resolve a crafted attention request into a foreign agent
  - A crafted workflowId delivered receive_user_response to a foreign workflow
  - Checking the attention row userId did not establish ownership of its targets
tags:
  - attention-requests
  - authorization
  - user-feedback
  - workflow-ownership
sources:
  - commit c65baa4f435f12b27fa3e6bd950a3711b6e2a275
  - PR #1511
repro: back-end/src/tests/blackbox/attention-requests.blackbox.ts
status: fixed
---

## Problem

Adversarial local verification of the authored-reply transport reproduced a
cross-account write. With its own JWT and no internal API key, the caller
created an attention request naming its own userId and a foreign agentId.
Creation and response both returned 200, and one USER row appeared in the
foreign agent's durable stream. A second replay used an owned agent with a
foreign workflowId: the real resolver delivered receive_user_response to that
foreign handle. A metadata waiter could carry the same mismatched pair.

These are local HTTP/database and fake-Temporal observations, not evidence of
production exploitation. They were discovered while repairing incident
ae17b024-5287-4199-84d0-6cce3bd1765d; they do not identify the caller behind
that incident's mobile pause failures.

## Diagnosis

The server mounts the attention router directly and delegates authentication
to each route. POST creation had no hybridAuth. Respond authenticated the
caller but compared it only with the request row's userId, which creation had
accepted from the caller. Neither that comparison nor agent ownership alone
established that a workflow belonged to the intended agent.

The deepest owned boundary was treating a stored caller claim as authority
for a write and a workflow signal. Authentication, request ownership, agent
ownership and workflow binding are distinct checks. Durable USER delivery
must validate all of them before committing or signaling.

Archive searches used "attention requests foreign workflow userId ownership"
and "cross account USER message unauthorized workflow signal". The August 4
impersonated machine-ingest case and August 19 attention-fence ownership case
are relatives with different first-bad boundaries, not a proven recurrence.

## Solution

Creation now authenticates callers, validates external claimed identity, and
checks target ownership. The shared durable-input transaction derives the
request owner and primary target from the locked database row and validates
every primary/waiter pair before a USER write or response commit. Late joins
use the same validation while holding the existing request lock.

Workflow validation uses authoritative current/stale bindings and the
production root/replacement identity format. Conflicting foreign mappings
and unknown arbitrary targets are rejected. It neither retargets a response
nor infers ownership from message text. Normal trusted worker API-key calls
remain subject to target binding checks. Permanent regressions cover JWT and
worker calls, legacy crafted rows, foreign primary/waiter workflows, atomic
rollback, and absence of foreign signals.

The original local attack artifacts are retained privately as
attention-ownership-before.txt and attention-workflow-binding-before.txt in
the isolated review worktree. The unchanged final identity regression returned unauthorized HTTP 200 before
the guard and 403 afterward; all 53 attention cases and the full auth-assistance
domain pass (3.687s and 2.185s). Auth creation with no current workflow uses
the agent root ID, proven through the actual create/complete API rather than
rewriting fixture rows (old empty workflow ID failed; native fallback passed).
A separate parent/child identity invariant rejects crafted legacy mismatches
before credential, control or USER writes. Scoped lint and formatting pass.
Final deployment validation is tracked by PR #1511. No production agent was modified for these tests.
The check batches the requested agent/workflow identities once per gate
operation and introduces no model-step polling or shared input queue.

## Human feedback

The user requested preservation of actual sent user messages and native schema
updates without harness injections. That requires binding a message to its
authorized destination; preserving authored bytes does not authorize delivery
to another account or an unrelated workflow.

## Reusable lesson

Bind durable user input and workflow signals to authenticated ownership and
authoritative target identities before committing either side effect.
