---
id: 2026-10-14-verifier-accepted-score-after-user-requirements-changed
date: 2026-10-14
title: Root verifier acceptance outlived the requirements its result judged
surface: agents
component: run_agent native verifier requirement version
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: root verifier consumers accepted the provider result after genuine user input changed its judged requirement version across an awaited call
symptoms:
  - root accepted a superseded USER verdict after provider await
  - final verifier retained stale completion progress after provider await
  - keyed correction without durable USER row accepted old schema after provider
  - verifier mixed the previous prompt with a newer native schema
tags:
  - verifier
  - user-feedback
  - response-schema
  - completion
sources:
  - agent ae17b024-5287-4199-84d0-6cce3bd1765d
  - commit 73cdeae14c543adca645420887bdf787d24384d9
  - commit c65baa4f4
  - commit 949b4be32
  - PR #1511
repro: agents/tests/blackbox/run_agent.blackbox.py::test_keyed_feedback_revision_supersedes_verdict_without_user_row
status: open
---

## Problem

Adversarial review atop native baseline 73cdeae14 reproduced a root completion
race. A verifier judged an existing requirement, then genuine user input arrived
during its provider, message-posting or token-accounting await. The caller could
accept that preceding result, including its old structured output.

A further keyed-response replay proves why durable USER identities alone are
insufficient: attention response handling can update the accepted requirement
revision and native schema without creating another durable USER row. A venue
name verdict remained eligible after a keyed instruction requested venue prices.
Separate replay shows prompt and schema getters returning different revisions
when feedback arrives between their awaited reads.

These are locally proved shared-verifier and workflow-caller defects. The
original Calendar evidence in
[the peer resume case](2026-10-14-suspended-browser-resume-omits-user-instructions.md)
shows missing browser inputs and a stale delegated account field. It does not
show the root accepting a stale result or establish that its events field was
wrong.

## Diagnosis

Path: accepted requirements -> prompt/schema reads -> provider result -> posting
and billing callbacks -> root completion acceptance. The result is scoped to
the version it actually judged. The earliest bad boundary is accepting it
without comparing that version against current input. Changes can retain the
same field names, and keyed input can leave the durable USER set unchanged.

The deepest owned cause is incomplete versioning of mutable requirements at
evaluation boundaries. The authoritative version combines real nonhidden USER
identities with the native accepted requirement revision. Prompt and schema
reads must also settle under one version before sending a request.

Archive searches user update during verifier stale completion and rejection
feedback root schema signal request_id found related purchase/evidence cases,
not this acceptance race. The linked peer case owns original instruction
custody. Golden custody analogs inspected there are Codex
codex-rs/core/src/session/input_queue.rs:389, Hermes
agent/agent_runtime_helpers.py:3758, OpenClaw
packages/agent-core/src/agent-loop.ts:221 and Claude src/query.ts:1570. Rose's
specific shared verifier version check has no established automatic
schema-generation analog in those references. This repair adds no prompt text.

## Solution

The current worktree extends integration base 949b4be32 atop peer native source
c65baa4f4, with subsequent reviewed acceptance/persistence repairs; 73cdeae14
remains the recorded earlier causal baseline. _run_verifier snapshots
the accepted revision before awaiting the prompt and
native schema getters, and repeats both reads if that revision changes. It
records the judged USER identities and revision in native result metadata,
then rechecks after provider and posting awaits. Normal, final and post-DAG
consumers recheck after accounting and other callbacks before accepting output.

The actual provider score, reasoning, structured result and usage are preserved.
Supersession marks the result in native metadata; it does not turn a provider
success into a manufactured score-zero rejection or add fabricated TOOL
narration. Normal execution continues with actual input. Final max-iteration
results carry an explicit supersession flag and omit stale completion progress
and partial output. Workflow soft acceptance and phase/post-DAG consumers honor
the same version guard. Existing budgets and iteration limits remain in force.

Source identity also follows the peer's authored attention event rather than a
physical DB row: a retry of the same source must not invalidate its own verdict.
test_verifier_uses_authored_attention_event_identity_across_row_retries failed
before that repair in native-verifier-event-identity-before.log and passed
unchanged afterward in native-verifier-event-identity-after.log (0.002s each).

Review further separated a processed schema revision from an accepted current
contract. A generation failure cannot certify the previous contract; valid
unchanged output still requires acceptance. The native candidate records its
accepted revision before the persistence await, preserves accepted schema state
across a lost acknowledgment, and uses pure generation so a superseded candidate
cannot write an obsolete schema before its owner rejects it.
native-workflow-accepted-revision-baseline.log records four causal failures;
native-workflow-accepted-revision-postfix.log records unchanged passes covering
old-contract getters/provider calls, unchanged-contract acceptance and lost
persistence acknowledgment. Direct/Fast Mode caller regressions failed before
their repair and pass afterward in native-workflow-acceptance-caller-{baseline,postfix}.log.
Five peer persistence/continuation controls also pass in that postfix log.
The first final owning workflow run exposed a protocol-only approval fixture
missing canonical user_message null, which incorrectly introduced a legacy
authored requirement and then correctly hit the acceptance guard. Its envelope
alone was corrected; the unchanged full-suite assertions passed in the interim
40.9s workflow rerun recorded below.

One introduced caller await exposed a further ordering race: current schema
acceptance could settle after the caller had already checked an older verdict.
The existing execute guard was moved after the final schema wait; post-DAG
acceptance also rechecks there before completing. The existing Fast Mode
post-wait guard remains intact. This orders acceptance checks without duplicate
guards or manufactured feedback. The tests
test_workflow_execute_completion_rechecks_verdict_after_schema_wait and
test_workflow_post_dag_completion_rechecks_verdict_after_schema_wait fail before
repair and pass unchanged afterward in
native-workflow-verdict-schema-wait-{baseline,postfix}.log; the Fast Mode sibling
test passes on both sides. The actual provider score remains 1.0 and its preceding
output remains byte-for-byte intact while acceptance is refused.

The earlier candidate 59fb6922b rewrote superseded scores and emitted rejection
feedback. It was withdrawn following the user's direction; the implementation
and evidence recorded here concern the native replacement atop PR #1511.

Permanent causal tests were run before repair and unchanged afterward. Exact
repeatable command from the native-coherence worktree:

    source agents/venv/bin/activate
    python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root . --baseline 73cdeae14c543adca645420887bdf787d24384d9 --runtime loop.run_agent run_agent test_verifier_rechecks_real_user_requirements_at_completion_boundaries test_final_verifier_does_not_publish_stale_completion_data test_superseded_verifier_keeps_actual_provider_result test_keyed_feedback_revision_supersedes_verdict_without_user_row test_verifier_reloads_prompt_and_schema_until_requirement_revision_matches

The identical invocation without --baseline loads the current runtime. The
runner loads baseline source from git show into an isolated module; permanent
test functions, assertions and fixtures are unchanged. native-root-causal-before.log
records five failures (exit 5): old success accepted (0.054s), stale final
progress retained (0.027s), no native supersession marker (0.001s), keyed
old-schema acceptance (0.007s), and mixed prompt/schema inputs (below logged
0.001s precision). native-root-causal-after.log records five passes (exit 0;
0.133s, 0.022s, 0.001s, 0.051s and below logged 0.001s precision). The fixtures
cover provider, posting and accounting boundaries, hidden-row controls, native
keyed input and exact actual usage preservation.

Earlier native-root-verdict-{before,after}.log and
native-keyed-revision-{before,after}.log retain the original pre-repair failures
and unchanged post-repair passes. Workflow post-DAG and shared
phase-forwarding tests also fail before revision plumbing and pass afterward
in native-workflow-keyed-revision-{baseline,postfix}.log. No live provider is
needed to decide these deterministic races.

Canonical owning commands, from agents with its venv activated:

    python scripts/run_blackbox_tests.py run_agent
    python scripts/run_blackbox_tests.py workflow

native-root-keyed-run-agent-blackbox.log records an earlier 61-registration
run-agent pass in 1.4s. The final root suite also fixes its external HTTP test
boundary: a legacy circuit-breaker fixture was registered three times, including
after mock teardown, and left a realtime batch span open during loop shutdown.
The suite retains the earliest registration, keeps native streaming/coalescing
real, mocks only realtime HTTP transport and drains its owned queue before
teardown. native-root-shutdown-investigation.log reproduces the shutdown
ContextVar error; native-root-legacy-broadcast-proof.log attributes the external
batch to the unchanged legacy fixture. native-root-shutdown-final.log records
60 unique registered checks passed in 1.4s with no shutdown context error. No
production tracing fallback or log suppression was added.
native-workflow-domain-keyed-revision.log records an earlier workflow domain
pass in 40.8s. native-workflow-domain-final-acceptance-rerun.log records an
interim owning workflow pass in 40.9s. After the final-wait ordering repair,
native-workflow-domain-final-wait-race.log records one workflow domain passed,
zero failed, 36.0s, including accepted contract, direct/Fast Mode caller,
persistence and final-wait controls. The permanent tests
are registered in the owning blackbox runners used by deploy agents coverage.
Subsequent source changes require fresh checks; no production acceptance is
claimed.

At 10,000 agents the guard uses an owning-agent incremental poll, its accepted
revision and per-verification USER identity set. It introduces no fleet scan,
global subscription or cross-agent event channel. The case remains open pending
rollout.

## Human feedback

The user required conditional schema refresh and the same standard for browser
and root work. Their later direction recorded in the peer case rejects harness
injections and asks to preserve sent input. The native fix keeps actual verdicts
and user instructions while preventing stale result acceptance.

## Reusable lesson

Accept a verifier result only while both the actual USER sources and native requirement revision it judged remain current, resolving prompt and schema under that same version.
