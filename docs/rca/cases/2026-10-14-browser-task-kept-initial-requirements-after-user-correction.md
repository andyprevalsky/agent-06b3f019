---
id: 2026-10-14-browser-task-kept-initial-requirements-after-user-correction
date: 2026-10-14
title: Active browser input could outlive its delegated completion contract
surface: agents
component: spawn-browser-agent-v3 active user instruction custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handler.py active browser execution did not reuse the resume input ledger to synchronize later USER instructions and its native output schema before decisions and verifier acceptance
symptoms:
  - durable USER correction absent from the next browser decision
  - browser completed from a passing verdict superseded by USER feedback during verification
  - Update: Do NOT sign in with tamara@roselabs.ai
  - Verifier rejected (50%) — continue task
tags:
  - browser
  - user-feedback
  - output-schema
  - verifier
sources:
  - agent ae17b024-5287-4199-84d0-6cce3bd1765d
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
  - commit 73cdeae14c543adca645420887bdf787d24384d9
  - commit c65baa4f4
  - commit 949b4be32
  - PR #1511
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_active_user_feedback_updates_model_and_verifier_preserving_fields
status: fixed
---

## Problem

The supplied Calendar incident is documented in
[the resume instruction-custody case](2026-10-14-suspended-browser-resume-omits-user-instructions.md).
At 17:28:33.341 UTC a durable USER correction changed account access from Tamara
to Andy and a shared-calendar search. Retained worker evidence records receipt
of a keyed authentication response at 17:28:33.446890 UTC, storage for request
68016e7d-4054-4c9e-8430-925c1b0c3b21, and subsequent browser resume. This was not
an ordinary unkeyed signal. The resumed actor and judge omitted the correction;
15 completion attempts were rejected at 50% before the agent was deleted.

Archived final browser verifier request 56a48ebda7ec independently proves a
delegated contract mismatch: signed_in_account still says the account should
be tamara@roselabs.ai. The root events schema was not shown to be wrong. The
delegated schema and actual user correction must remain scoped to the browser
task; copying the root field set would lose delegated requirements.

PR #1511 owns the missing resume-input transport and native schema repair.
Its documented resume-only polling behavior describes that peer baseline;
the active-loop extension here additionally polls at decision and verification
boundaries.
Local replay atop its coordinated baseline 73cdeae14 identified residual active
execution gaps: a correction arriving after initialization was absent from the
next actor/judge inputs, and a correction arriving during verification could
leave the previous passing verdict eligible for completion. These are locally
reproduced extensions of the shared contract, not another claim about the
deleted incident's final outcome.

## Diagnosis

Path: durable USER instruction -> scoped cursor/source-ID ledger -> active
browser decision and native output schema -> grounded browser verification ->
completion acceptance. The peer baseline delivered instructions on resume.
The residual first bad boundary was later active execution failing to consume
the same authoritative input stream before its next decision or acceptance.

The deepest owned cause is inconsistent custody of mutable requirements across
execution and evaluation boundaries. The existing resume ledger already owns
input identity, ordering and continuity, so extending it removes a separate
source of truth. Actual user instructions can reach a subordinate verifier;
unrelated parent tool claims cannot replace browser page evidence.

Archive searches used Verifier rejected (50%) continue task; browser output
schema user feedback changes goal; and user correction browser auth assistance
resume goal. Purchase and approved-card cases are relatives with different
boundaries. The linked peer case owns the original resume failure; this case
records active-input and result-version residuals against its native baseline.

Golden custody references already inspected for the peer case: Codex
codex-rs/core/src/session/input_queue.rs:389 drains typed input; Hermes
agent/agent_runtime_helpers.py:3758 appends actual steering after a tool batch;
OpenClaw packages/agent-core/src/agent-loop.ts:221 commits queued input before
the next call; Claude src/query.ts:1570 drains scoped queued commands. Their
shared pattern preserves original input at an execution boundary. No automatic
goal-derived schema-generation analog was established; Rose reuses its own
existing generator. No new prompt instruction is part of this repair.

## Solution

The current worktree extends integration base 949b4be32, based on the peer's
later coordinated native source c65baa4f4, with subsequent reviewed repairs;
73cdeae14 remains the recorded earlier causal baseline.
The incremental implementation in native-coherence extends PR #1511's cursor,
source-ID ledger, instruction list and native browser_output_schema through
active real and simulated loops. Decisions and both verifier paths consume the
actual messages. Schema generation receives the delegated task's current
contract and ordered instructions, then rechecks the tail for input arriving
during generation. Without new or unacknowledged input, no generation runs. Equivalent effective
verifier schemas retain the existing contract, including cosmetic defaults.

The shared generated-schema parser preserves emitted top-level and nested
descriptions, nullability, bounds and properties. Schema changes update native
state and actor contracts directly. Superseded verification cannot complete the
task or reuse structured data cached under preceding requirements. Actual
provider verdicts and usage remain intact; no score-zero rejection is invented.
Real and simulated continuity preserves original user text, including the full
instruction tail across a bounded action-history resume.

The earlier candidate 59fb6922b used generated schema USER rows and fabricated
supersession rejection feedback. It was withdrawn after the user's direction.
It is not the rollout candidate, and its passing tests are not substituted for
the native implementation's evidence.

The permanent active-input tests ran against baseline 73cdeae14 and the native
candidate with unchanged assertions. Exact recorded command from the
native-coherence worktree, using the retained local runner:

    source agents/venv/bin/activate
    python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root . --baseline 73cdeae14c543adca645420887bdf787d24384d9 --runtime domains.spawn_browser_agent_v3.handler spawn_browser_agent_v3 test_browser_active_user_feedback_updates_model_and_verifier_preserving_fields test_browser_active_user_feedback_changes_only_browser_output_fields test_browser_feedback_arriving_during_verifier_invalidates_passing_verdict test_browser_schema_revision_discards_previous_verifier_structured_response

The identical test invocation without --baseline loads the current runtime.
The runner loads git-show baseline runtime source in an isolated module;
test functions, assertions and fixtures are unchanged. native-browser-causal-before.log
records four failures: missing input (0.704s and 0.130s), stale passing-verdict
acceptance (0.135s), and cached stale fields (0.207s), exit 4.
native-browser-causal-after.log records four passes (0.803s, 0.152s, 0.236s and
0.179s), exit 0. Earlier native-browser-{baseline,after}.log recordings remain
available as supporting evidence.
The fixtures drive the real activity and verifier context builder with captured
goal/correction text and mocked external browser/provider calls. They prove the
owned input and contract boundaries, not live Calendar completion.

Canonical owning command, from agents with its venv activated:

    python scripts/run_blackbox_tests.py spawn-browser-agent-v3

native-browser-domain-current.log records a prior domain pass in 53.4s.
Intermediate full-suite failures in native-browser-domain-final.log
and native-browser-domain-verified.log were resolved before this passing run;
they are retained as evidence. The three peer schema/auth controls pass in
native-peer-schema-control.log. The shared LLM domain passes 228 checks in 7.0s
in native-llm-blackbox.log. Simulated active-input and full-tail resume controls
failed before repair and passed afterward; their owning world-model-harness
domain passed in the recorded combined run. These tests are registered in the
normal blackbox runner used by deploy agents coverage.

Final review found four additional causal failures, recorded in
native-active-review-red.log and registered in the permanent owning suites:
test_browser_active_schema_failure_delivers_real_input_and_retries_unacknowledged_contract
raised schema provider unavailable;
test_browser_coalesced_schema_failure_retains_completed_usage_and_latest_input
raised later schema refresh unavailable;
test_browser_pending_schema_failure_does_not_accept_previous_contract_completion
accepted an unacknowledged deliverable under the old schema; and
test_simulated_browser_user_feedback_invalidates_pending_approved_action
executed a queued approved write before reconsidering real input. The existing
no-new-input approval control passed. These expose custody across schema-provider
failure and pending-action execution: receiving actual input, accounting for a
completed generation call and acknowledging a replacement contract cannot be
one indivisible success-only step. The repairs deliver actual input independently
of schema-generation success, account completed calls immediately, retry an
unacknowledged contract after a fresh suspension, and refuse stale completion.
Fresh input also invalidates a queued simulated approval so the actor
reconsiders it before a write. The existing no-input approval path remains valid.

Unchanged focused regressions pass on the integrated worktree in
native-active-review-green.log: 0.500s, 0.006s, 0.344s and 0.008s, with the
no-input approval control passing in 0.005s. Exact retained runner command from
native-coherence/agents with its venv activated:

    python /home/boxes/rose/.context/rca-ae17b024/native-active-review-repro.py

The peer's existing schema-failure test was strengthened only in its failure
branch to retain actor/judge/auth/cleanup assertions while requiring an
incomplete result with no structured output. It fails against actual c65baa4f4
runtime in native-peer-failure-completion-before.log (0.685s) and passes on the
integrated repair in native-peer-failure-completion-after.log (8.911s). This
closes old-contract success after failed regeneration rather than accepting it
as a fallback. The final canonical browser rerun includes the new failure cases
and this strengthened peer control: native-integrated-browser-final.log records
one domain passed, zero failed, 64.5s. Shared LLM and world-model-harness owning
domains also pass in native-integrated-owning-domains.log; its earlier browser
failure is superseded by the final browser run.

At 10,000 agents, reads remain scoped to each owning agent and its incremental
cursor; schema calls process newly received or retryable unacknowledged real
instructions. The design adds no
global subscriber, fleet scan or shared user fan-in. Per-task instruction and
identity state grows with that task's input history.

Final root owning checks also pass: 60 unique run-agent checks in 1.4s with
clean realtime-test teardown, and the final workflow domain in 36.0s after its
schema-wait acceptance ordering regression was repaired. The sibling verifier
case records that separate boundary and its causal proof. The shared How-format
test passes all five templates; it adds no runtime prompt or approval gate.

Status remains open pending rollout. The
deleted agent's frontend viewer and completed Calendar outcome are unverified.
The peer separately rendered and published dump 56a48ebda7ec; its expiring
private evidence URL is kept outside this archive. No signed access credential
is committed here.

### Runtime handoff and legacy simulated-resume follow-up

The coordinated runtime-only handoff is commit
2735cb0fc1fd82f7b41512737e0e6b54c7858655 on
fix/browser-feedback-native-runtime, based on c65baa4f4. PR #1511 owns its atomic
integration, full gates, review and rollout together with its source-persistence
and mobile fixes. PR #1513 now owns only the user-requested How/template change.
The complete earlier native snapshot ab4d262ef remains preserved separately.

The receiving owner identified another instance of missing input: a nonempty
legacy simulated-browser resume had no saved cursor, but initialization seeded
it with the current time. A USER correction sent while it was suspended was
therefore older than that cursor and skipped by the actual incremental read.
The permanent owning fixture
 test_simulated_browser_legacy_resume_reads_feedback_sent_during_pause
uses a timestamp-filtered durable source and fails on the handed-off runtime:
"resumed approval executed the queued write before reconsidering real USER
feedback" (exit 1, 0.453s). The identical assertion passes (exit 0, 0.429s) after initialization
seeds a current watermark only for a brand-new simulated activity. Legacy
snapshots use the existing epoch/source-ID fallback; no second transport is
introduced. The no-input approved-action control remains unchanged. The complete
world-model-harness owning domain passes all 49 checks in 3.5s; its new
legacy-resume test is registered in that deploy-owned runner.

Exact command, from the activated agents environment at the native worktree:

    python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root . --runtime domains.spawn_browser_agent_v3.handler world_model_harness test_simulated_browser_legacy_resume_reads_feedback_sent_during_pause test_simulated_browser_user_feedback_invalidates_pending_approved_action test_simulated_browser_persists_post_approval_confirmation_state

The audit found that all production persist_resume_context producers are in the
real activity, while simulated payment/write suspensions return inline state.
There is no proved production simulated pointer-backed producer, so this
follow-up adds no speculative hydration path. The runtime owner will integrate
the follow-up before the single PR #1511 rollout.

### Fresh simulated activity scheduling follow-up

A fresh simulated activity used its execution-time wall clock as the initial
USER cursor. With the real timestamp-filtered source, a correction committed
after Temporal scheduled the activity but before a worker executed it was
skipped. The real browser activity already starts from
`activity.info().scheduled_time`; the simulator now uses that same boundary.

The permanent owning test
`test_simulated_browser_preserves_user_input_queued_before_activity_execution`
sets scheduling to 30 seconds before execution and queues actual USER text one
second after scheduling. The unchanged fixture fails before the fix because
the first policy input omits that correction, and passes afterward with the
same bytes also present for verification. A USER row from before scheduling
remains excluded; the no-input fresh control performs no schema generation,
and the existing legacy-resume controls remain intact. No epoch replay for
fresh activities, prompt, transport, or fallback was added.

Full owning command from `agents/`:

    venv/bin/python scripts/run_blackbox_tests.py world-model-harness

The exact before/after console artifacts are retained privately as
`.context/rca-ae17b024/sim-startup-{before,after}.txt`. This is a deterministic
startup custody reproduction, not a claim that the deleted production run
was observed using simulator mode.

## Cycle 2 availability and completion follow-up

Review comments 4277021231 and 4277021245 exposed two availability defects in
the same input/schema boundary. A backend poll error escaped the ordinary
step loop and ended the browser task. A failed schema generation marked its
instruction revision attempted, but completion repeatedly continued without
retrying that revision or changing the model context. Both real and simulated
browsers could consume their remaining iterations without an accepted contract.

Archive searches were `schema provider unavailable browser instruction poll`
and `browser correction completion max iterations retry schema`. They identify
this existing case and the linked suspended-browser case; this is a follow-up
to the same native instruction custody boundary, not a separate model defect.

The repair keeps the latest successfully admitted input, cursor, accepted
schema and known usage even if the next poll fails. A poll miss triggers one
conditional confirming read before actor execution; a second miss returns a
native failure before any click, script evaluation or payment action. A
startup miss disqualifies the old queued approved action. Generation sealing
and cancellation continue to propagate.

Completion makes at most two actual schema attempts for an unaccepted revision:
the ordinary attempt plus one completion retry, or two conditional attempts
when the input first appears at completion. A persistent failure returns the
actual error through the native failed-result/cleanup path, with no structured
response, stale-schema approval, repeated actor turn or generated conversation
message. Actual announced tool streams resolve ERROR. Known actor and schema
usage reaches the manager once; recording cleanup remains independent of a
failed realtime tool-stream write. Final max-step verification uses the same
input freshness and accepted-revision requirements.

Permanent owning tests cover real and simulated transient recovery, permanent
failure, first-seen-at-completion retry, partial-success/second-poll failure,
pending approved writes, generation sealing, actual tool-stream closure and
known usage through the manager. The identical focused runner against the
original `1ed6269b3ee79e2b41bcc3bb44717d4515d10e6c` handler and the candidate
retains `browser-transient-final-before.txt` and
`browser-transient-final-after.txt` under the isolated worktree's
`agents/.context/`; `browser-transient-frozen-blobs.json` records the exact code
and test hashes for the final owning run. Existing successful actor/judge,
authorization, compute-auth and no-input approval controls remain applicable.

Final focused results were 15 failures and one preserved generation-seal control
on the original handler, followed by all 16 passing with identical assertions
on the candidate. Both complete owning domains passed in 60.4 seconds against
the unchanged recorded blobs (`browser-transient-owning-frozen-final.txt`).
Scoped Ruff, compilation, diff checks and archive validation passed.

## Human feedback

The user required schema updates only when needed and the same standard for
browser and root agents. The later direction recorded in the linked peer case
was to preserve sent user messages and remove harness injections. This revision
uses actual input and native state, without generated schema USER/TOOL narration.

## Reusable lesson

Reuse the delegated task's authoritative input ledger for decisions, native schema updates and verdict acceptance throughout active execution and resume.
