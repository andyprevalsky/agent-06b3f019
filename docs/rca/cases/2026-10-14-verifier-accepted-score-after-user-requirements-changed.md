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
status: fixed
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

### Fresh-start acceptance gap found in final review, 2026-10-15

PR #1511 review comment 4277591962 identified a related acceptance path on
9b8b694bb47f211443b3d3a32fe375036f7bed5c. This is a locally reproduced
fresh-start defect, not additional evidence about the original Calendar outcome.
The deployment was held before merge. Archive searches `schema generation
returned no fields` and `fresh start stale response schema completion followup`
found this acceptance case and schema-contract relatives; the new evidence is
appended here because the same native acceptance invariant was incomplete.

Path: a real USER follow-up supersedes a completed task -> fresh workflow clears
the old native schema -> latest-USER schema generation fails or returns empty
fields -> the helper returns without claiming a requirement revision -> completion
sees revision zero as accepted and reloads the completed task's database schema.
The first bad boundary is the fresh-start helper's missing acceptance state,
not the completion card renderer or provider result. The earlier mid-run tests
did not exercise this separate startup helper.

The fresh-start helper now claims a native requirement revision, generates with
`persist=False`, and discards a candidate if actual input supersedes it during
generation. A valid candidate, including an unchanged schema, is accepted before
the database write await. Generation failures remain unaccepted; a lost persistence
acknowledgement retains the accepted native contract. The terminal method checks
that acceptance before it can latch completion, post a summary, or reload a
database schema. It adds no additional schema await between the caller's verdict
check and completion. No synthetic USER/TOOL narration, model score changes,
browser transport, timeout changes, or How/template changes are part of this fix.

Six permanent tests were run against unchanged 9b8b694 source and then against
the repaired source with identical fixtures/assertions. Exact commands from the
isolated `root-fresh-start/agents` directory, with the reused venv activated:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. --baseline 9b8b694bb47f211443b3d3a32fe375036f7bed5c --runtime workflows.agent_workflow workflow test_workflow_fresh_start_generation_failure_cannot_restore_completed_task_schema test_workflow_fresh_start_empty_schema_cannot_restore_completed_task_schema test_workflow_fresh_start_accepted_schema_survives_lost_persistence_ack test_workflow_mark_complete_refuses_failed_fresh_start_before_terminal_effects test_workflow_fresh_start_discards_schema_superseded_during_generation test_workflow_fresh_start_unchanged_schema_is_accepted_before_persistence
```

The identical command without `--baseline ... --runtime workflows.agent_workflow`
uses the current runtime. The private runner loads the unchanged permanent tests
and swaps only the runtime module with `git show` for the baseline run.
`root-fresh-schema-all-before.log` records exit 6: both generation failures
completed using the stale database contract; the direct terminal path accepted
failed generation; an obsolete generated candidate was adopted; native accepted
revision and unchanged-schema acceptance were absent. The first five tests also
failed before any source edit in `root-fresh-schema-before.log` (exit 5).
`root-fresh-schema-all-after.log` records all six passing (exit 0).

The exception/empty-field/lost-ack tests execute the actual fresh `run` and
`_mark_complete` methods, replacing only external activities and the agent turn.
They assert no stale database reload, summary generation, or terminal latch after
failure, and successful completion with the accepted new schema after a lost DB
ack. Other tests exercise the direct terminal bypass, in-flight authored input,
and continuation before the write acknowledgement. The existing stale-plan and
native-input/no-injection controls remain unchanged.

The owning deploy runner discovers all six tests. Canonical command:

```bash
python scripts/run_blackbox_tests.py workflow workflow_determinism
```

`root-fresh-schema-final-workflow.log` records two domains passed, zero failed
(42.1s), including all seven new tests and five determinism checks. Ruff lint and
the prompt, trajectory and agent-behavior guards pass against the exact 9b8b694
base. Independent read-only review found no blocker and independently ran the
first five causal tests. This is runtime-only development handoff to the PR #1511
owner for combined validation and deployment; no production rollout or original
Calendar task success is claimed here.

Final handoff audit added a seventh causal case: an authored signal can already
be queued when this helper receives its earlier startup-history snapshot.
Unconditionally claiming and accepting a new revision then consumed that input
without generating from it. The permanent test
`test_workflow_fresh_start_keeps_feedback_received_before_generation_pending`
fails on initial isolated fix 809711d818ba665a9fab275a6e8addc807a3f8f3 and passes
after the helper detects preexisting pending feedback and defers to the existing
coalescing worker. It adds no second generator or input poll. Exact command:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. workflow test_workflow_fresh_start_keeps_feedback_received_before_generation_pending
```

The unchanged invocation failed before that four-line repair (exit 1,
`fresh-start acceptance consumed earlier queued feedback without generating from
it`) and passed afterward (exit 0); the corresponding private logs are
`root-fresh-schema-pending-{before,after}.log`. Independent review also passed
this follow-up and ran its test. Combined workflow/determinism validation was
rerun on the final source after this repair: two domains passed, zero failed
(42.1s). The earlier 37.1s pass was interim.

## October 15 follow-up: finish rejected native contracts durably

Review 5526868411 of frozen PR #1511 source
`f2625c20ded63a76b625b526f95a23a9b5f90886` found an incomplete failure path in
the fresh-start acceptance repair. The native guard prevented stale schema
acceptance, but its plain RuntimeError could escape direct execute, post-DAG,
Fast Mode and final-completion paths. The Temporal worker does not configure
ordinary RuntimeError as a workflow failure, so the workflow task could retry
without publishing the agent's existing FAILED state. This is a follow-up
failure-handling defect, not evidence of that root outcome in the Calendar run.

The guard now raises a specific RuntimeError subclass. A narrow boundary around
the registered workflow entry catches only that class and invokes the existing
`_mark_failed` path with the original reason. Unrelated RuntimeError,
cancellation and generation handoff retain their existing behavior. The current
schema requirement, accepted revisions, provider judgment, iteration limits and
the seven earlier fresh-start controls remain enforced. Temporal registration
still selects the actual guarded coroutine and preserves its argument signature.

The permanent run-level case exercises all four direct completion paths and
asserts the actual FAILED status write, original failure message, and absence
of stale-schema reload or successful completion. Its unrelated-error control
passes before and after. From `agents/`, the exact causal command is:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. --baseline f2625c20ded63a76b625b526f95a23a9b5f90886 --runtime workflows.agent_workflow workflow test_workflow_unaccepted_schema_completion_reaches_durable_failure test_workflow_schema_failure_handler_does_not_swallow_unrelated_errors
```

The first case fails on frozen f262 with `execute schema rejection escaped as
retryable workflow-task error: set_response_schema_activity failed`; the
unrelated-error control passes. Omitting only `--baseline` and its value makes
both pass with unchanged assertions. The combined before/after transcripts are
`.context/root-review-causal-{before,after}.log`; they also contain the fresh-task
intake regression documented in the linked root intake case. The full owning
`python scripts/run_blackbox_tests.py workflow workflow_determinism` passes two
domains with zero failures in 38.6s on the final combined source, retained in
`.context/root-review-final-owning-v2.log`. The earlier 37.4s pass is interim.
Scoped cached Ruff, compilation and diff
checks pass. Independent review of the terminal boundary is clean.

Archive searches used `No output schema has been accepted RuntimeError workflow
task` and `fresh followup historical USER response schema`. Existing schema
acceptance and rejection-intake cases are the relevant leads; unrelated archive
deadline RuntimeError cases have different owners. This evidence is appended
here instead of claiming a second occurrence of the original Calendar outcome.

The incremental agent-behavior approval guard flags this terminal mapping;
neither an approval flag nor an override was supplied. That result and the
exact frozen diff are handed to the PR #1511 deployment owner for the required
authorization disposition. Prompt and trajectory-injection guards pass.

## October 15 follow-up: pending feedback across terminal startup and drain

The final read-only audit of root candidate
`25c0abcae2bad3dba1e94fb10ae22abbdc42b24c` reproduced a distinct acceptance gap.
The real workflow returned a completed verdict, then `_mark_complete` awaited
its actual deferred startup SMS handle. A genuine USER signal arrived during
that wait while healthy schema generation was still pending. The synchronous
acceptance guard raised the typed rejection, and the workflow durably failed
with `No output schema has been accepted for the current user requirements`.
No generation failure was configured; releasing the provider completed native
acceptance at revision 1/1. The existing deferred fixture only covered a real
generator failure, so it could not distinguish this healthy pending revision.
A second pre-latch wait, the native Fast Mode explore drain, could instead let
an old completion proceed after genuine input changed its requirements.

The repair consumes the existing SMS and explore waits before each production
completion caller's final schema wait, acceptance check and verdict decision.
It captures the native requirement revision before those waits and checks it
again afterward, including when the generated schema is unchanged. Execute
uses its existing continuation; post-DAG uses its existing reasoning recovery;
Fast Mode keeps its existing maximum-step failure when the old trajectory no
longer certifies completion. The final terminal method retains its idempotent
startup/drain safeguards. No schema wait was added inside that method to bless
old output, and the typed generation-failure boundary is unchanged.

The permanent owning cases deliver an actual USER signal while the real
startup or drain operation is awaiting a controlled handle. They require no
old completion, no schema-error failure for healthy generation, and the current
accepted contract plus actual input in native continuation or recovery. The
changed-schema and unchanged-schema cases both failed on the frozen candidate
and pass with the same assertions after this repair. Actual generator failures
and unrelated RuntimeError controls retain their previous outcomes. This is a
follow-up to the same awaited verifier-consumer boundary, not another proven
occurrence in the original Calendar run.

The unchanged final fixture produces five causal failures on `25c0abcae` and
passes its no-input control. Against the repair, those six cases plus the two
existing error controls all pass (0.001–0.004s per case). Exact commands from
`agents/`, with the existing agents venv activated:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. --baseline 25c0abcae --runtime workflows.agent_workflow workflow test_workflow_healthy_feedback_during_native_sms_wait_continues_with_changed_schema test_workflow_healthy_feedback_during_native_sms_wait_continues_with_unchanged_schema test_workflow_healthy_feedback_during_native_explore_drain_discards_old_completion test_workflow_healthy_sms_feedback_post_dag_recovers_current_contract test_workflow_healthy_sms_feedback_keeps_fast_mode_step_budget test_workflow_native_sms_completion_without_new_feedback_still_completes
# Repeat without --baseline and its value for the repaired native source.
python scripts/run_blackbox_tests.py workflow workflow_determinism
```

The full owning runner discovers all six additions and passes both domains with
zero failures in 42.9s. Captures are `root-healthy-terminal-waits-before.log` and
`root-healthy-terminal-waits-after.log` in the local RCA evidence directory;
the full transcript is `.context/root-healthy-terminal-full-owning.log` in this
worktree. Scoped Ruff, compilation, archive validation and diff checks pass.
Independent read-only review of the exact completion-await patch is clean.
Prompt and trajectory guards pass; the agent-behavior guard remains flagged
without an approval or override. No paid probes or deployment ran on this box.
The existing native continuation is the direct Rose standard; the inspected
Codex `codex-rs/core/src/session/input_queue.rs:389` similarly preserves input
under the active turn's custody. Neither claims a direct schema-generation
analog; this repair keeps current input authoritative through the last awaited
preparation before terminal acceptance.

Archive searches used `No output schema has been accepted pending schema
deferred startup` and `feedback during completion SMS drain stale verifier`.
They returned this verifier case and the related root-intake/browser-contract
cases. The failure evidence, native source identity and previous acceptance
controls remain recorded rather than replacing the earlier investigation.
The previous approval request was explicitly superseded before any approval
claim; this updated runtime snapshot remains subject to the deployment owner's
narrow terminal-behavior authorization and final release gates.

## October 15 user correction: reuse native schema and LLM retries

At 21:37Z the user explicitly rejected RCA-TERMINAL-2 and the proposed new
schema-error-to-FAILED mapping. Their direction was that initial schema
generation already worked and refresh must reuse the existing timeout and LLM
retry path. No approval, merge or production rollout of that rejected candidate
occurred. The previous three-review ledger, rejected card, qualification and
post-review native histories remain preserved; db21 and its earlier composed
merge tree are obsolete deployment candidates. The prior terminal-policy
sections above are historical investigation, not the current product decision.

The new first-bad boundary is independently reproduced through the actual
`set_response_schema_activity`, actual Rose schema helper and actual
`call_temporal_activity_from_activity` retry owner. Initial generation succeeds.
The exact authored correction `  Use Andy's account instead.\n` then meets three
mocked provider ReadTimeout errors. On db21, exhausted generation is swallowed
as a successful None, so the existing activity retry never happens. The same
unchanged fixture passes after the catch rethrows: the next existing activity
attempt accepts the replacement schema, all retries retain the authored bytes,
and only the initial accepted generation performs the original schema write.
The exhaustion control makes nine calls (existing three generation attempts
inside existing three activity attempts) and propagates the original timeout,
instead of returning successful None. These are offline boundary proofs; they
are not evidence of a newly observed live Calendar generation timeout or of
successful completion of the deleted Calendar agent.

The schema helper already had three attempts, 0.2/0.4-second backoff and
2000-to-4000 length escalation. RoseClient already owns credential rotation,
route fallback and its 90-second per-call deadline. The defect was bypassing
the existing outer owner, then acknowledging a failed requirement revision.
The repair preserves those model-call budgets and auth/cache behavior and uses
the shared STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS envelope (600 seconds), which
normal LLM activities already use. The former 90-second activity envelope
could preempt the helper's existing three 90-second calls; no provider deadline,
benchmark timeout, task budget, evaluator or iteration cap is increased.

Root refresh leaves failed requirements pending. The ordinary response-schema
getter propagates the failed call into run_agent's existing three-consecutive-
failures boundary, with its existing iteration refund and backoff. The try now
also encloses prerequisite schema/prompt/message preparation; schema is fetched
before building that turn's prompt and matching completed-child fields. There
is no additional retry counter or loop. Actual cancellation, sealed generation
and generation handoff propagate by the existing cause-chain check. The new
FAILED wrapper and exception class are removed. After the ordinary retry owner
really exhausts, its existing error outcome is handled without another schema
await. Superseded verdicts retain checks after awaited work, and post-DAG
recovery and Fast Mode's existing step cap remain intact.

Native continuation carries pending revisions and the exact original feedback,
never an Exception object. Existing persisted snapshots can have
applied==revision==failed_revision with no accepted field and cleared error;
restoration reopens that proven failed input, rather than treating processing
as acceptance or exhausting three getter retries without any generation call.
A valid native schema with a lost persistence acknowledgement retains its
acceptance and retries the write without regenerating the schema.

Independent read-only review reproduced a second schedule: a signal-started
worker finished with SDK cancellation or a generation fence before any getter
awaited it, then the next getter silently started another call. The repaired
worker retains its completed exceptional task until the boundary observes it.
The same lifecycle check precedes the prerequisite durable-message poll's
ordinary read-failure fallback. Permanent controls complete the actual
background task before the getter and require the identical direct or wrapped
stop, one generation attempt at most, and zero generation calls when the poll
itself stops. Ordinary unavailable reads still preserve known actual input.
The same cause-chain exclusions also apply to the browser schema helper and
its prerequisite input read, whose former generic catches excluded only the
direct sealed-generation class. A registered real sync/refresh control covers
12 direct/wrapped SDK-cancellation, sealed-generation and handoff branches,
requires the identical stop and no extra read/generation, and fails on the
unchanged preceding source before passing after this narrow repair. Existing
ordinary browser schema-failure recovery tests retain their expectations.

Exact local commands (activated agents venv, repository root):

```bash
agents/venv/bin/python .context/rca-ae17b024/prove-native-schema-retry.py --baseline db21aefc86fa5103c14083575b76cb8ed7223653
agents/venv/bin/python .context/rca-ae17b024/prove-native-schema-retry.py
agents/venv/bin/python .context/rca-ae17b024/review2-terminal-replay.py --baseline db21aefc86fa5103c14083575b76cb8ed7223653 --case test_workflow_failed_schema_continuation_retries_original_input_without_new_feedback --case test_workflow_schema_refresh_lifecycle_stop_propagates_without_respawn
# Omit --baseline and its value for the identical fixed-source assertions.
cd agents
python scripts/run_blackbox_tests.py llm workflow workflow_determinism run-agent
```

The two actual activity fixtures fail before and pass after the fix; the two
continuation/lifecycle fixtures also fail before and pass unchanged afterward.
The combined owning run passes all four domains (LLM 231, run-agent 65,
determinism 5, plus the complete workflow suite) in 60.7 seconds before the last
additive continuation/lifecycle controls; final full agents coverage passes all 110 domains, 184 fast-cache tests and
134 unit tests at 82%. An additional instrumented workflow/determinism run
qualifies the final lifecycle and legacy-state repair on the frozen source. Five additive actual run_agent cases separately fail
against db21 and pass after the mechanical retry-boundary repair. The existing
60 run_agent test functions and every existing LLM-visible string are AST
identical; only lifecycle type labels are added. No user/tool narration,
auth cue, schema-update synthetic USER message or classifier is introduced.

Archive searches `schema generation timeout retry` and `schema refresh user
feedback None` found the earlier open schema-wall-deadline case and this
requirement-version family. The September 30 record already shows a failed
90-second schema call followed by a successful unchanged retry; it does not
prove the provider cause or close its original evidence gap. This follow-up is
a retry-contract relative, recorded here with the rejected verifier-terminal
policy it replaces. The golden reference for this repair is Rose's existing
LLM activity/loop retry owner; Codex input_queue custody remains the input
preservation analog, without claiming a schema-generation equivalent.

## Human feedback

The user explicitly rejected a new FAILED policy for schema errors and directed
reuse of existing timeout and LLM retries. That instruction supersedes the earlier
proposed terminal boundary. The user required conditional schema refresh and the same standard for browser
and root work. Their later direction recorded in the peer case rejects harness
injections and asks to preserve sent input. The native fix keeps actual verdicts
and user instructions while preventing stale result acceptance.

## Reusable lesson

Accept a verifier result only while both the actual USER sources and native requirement revision it judged remain current, resolving prompt and schema under that same version.
