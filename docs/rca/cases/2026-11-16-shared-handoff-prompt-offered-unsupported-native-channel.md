---
id: 2026-11-16-shared-handoff-prompt-offered-unsupported-native-channel
date: 2026-11-16
title: Shared result instructions offered transport persistence to a legacy code adapter that only reads a handoff file
surface: back-end
component: code-agent-result-prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeAgentPrompt.ts replaced the shared required-file contract with an alternative transport-persistence instruction although legacy Claude has no such writer
symptoms:
  - "close returned no handoff file at /home/user/.rose/handoff.json"
  - "smoke -- Claude Code answers 2+2 (real E2B sandbox)"
  - "the transport persists your JSON response or you write"
tags:
  - code-agent
  - handoff
  - unsupported-capability
  - prompt-contract
sources:
  - PR #2290
  - commit 546e440154645f394ddb683bf6dd019fe8f44474
  - PR #2290 deploy gate e2b-smoke, flaky occurrence 2ac0b28bdf8c48cba65b3021129a4661
repro: back-end/src/tests/blackbox/code-session-merge-facts.blackbox.ts legacy handoff system instructions require the result file without offering native persistence
status: fixed
---

## Problem

The real Claude 2+2 smoke failed its first attempt because the requested output
and final sentinel existed but the handoff file did not. Its automatic rerun
passed after explicitly writing the handoff. The passing rerun is retained as
FLAKY, not treated as attribution. Full CLI transcripts and their instruction
files were captured privately in /tmp/rca-118fff32-claude-flaky-rca.

## Diagnosis

Gate: INTRODUCED. The repair changed the shared system contract to offer two
ways to return the result, but the legacy Claude transport only reads a file.
The failed actor chose the offered JSON-response path; no transport persisted
it. A replay of its recorded actions reproduced the missing-file assertion on
both base and candidate readers; a replay of the successful file-writing
attempt passed both readers. The reader is consistent, not the first bad data.

The earlier generic prompt change attempted to accommodate native Codex by
changing a shared instruction. The correct boundary is the native adapter's
explicit task protocol. Offering a capability to all providers creates a valid
interpretation that some adapters cannot execute. The in-flight PR1874 listener
race concerns event collection and does not explain this missing file.

A local contract probe against the actual builder fails with exit1 while the
unsupported alternative is present and passes with exit0 after restoring the
existing explicit file requirement. The canonical shared prompt and version
headers now match main; the backend regression domain passes 13/13. No
model-intelligence limitation or guaranteed model behavior is claimed from
these observations; subsequent real-path verification remains required.

## Solution

Restore the original shared prompt and its version headers, leaving no net
legacy prompt change. Native Codex's marked task section still identifies its
transport-owned writer, which can satisfy the common requirement that the file
exist. Verify the native restricted task, ordinary file task and real legacy
Claude smoke together. If that native path cannot satisfy the unchanged shared
contract, choose an explicit capability-specific builder rather than rewriting
shared sentences downstream. No fallback, schema weakening or model change is
part of this repair. With the restored prompt, the full native Codex domain
passed 34/34, no skips (88.441s), including the single-command task; legacy
Claude with BLACKBOX_SMOKE=1 passed 59/59, no skips (26.100s). All owned
sandboxes were terminated. Deployment-wide validation and shipping remain;
the case is open.

### Landed qualification (2026-11-16)

PR #2290 merged as cc7a39b2846aa385320386bbb1374e74c989e6a4. The shared
prompt restoration left no net legacy prompt change; the recorded real Claude
59/59 pass and subsequent full 17-gate qualification support this repair.
This closes the candidate regression only; it does not claim transport-owned
handoff for legacy providers. Full production deployment still awaited the
separate Fly verifier repair.

## Human feedback

None recorded.

## Reusable lesson

Select result persistence at the adapter that owns the capability instead of offering unsupported alternatives in a shared agent prompt.
