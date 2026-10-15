---
id: 2026-10-14-rejection-feedback-skipped-root-schema-refresh
date: 2026-10-14
title: Root rejection intake confused durable context with accepted requirements
surface: agents
component: AgentWorkflow native requirement intake
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentWorkflow keyed rejection handling did not admit unacknowledged durable USER requirements already present in context or returned by polling
symptoms:
  - keyed rejection ignored its already-polled durable USER correction
  - keyed rejection did not poll/admit the durable USER correction
  - schema intake deduplicated a distinct USER reversion by text instead of durable identity
tags:
  - user-feedback
  - approval
  - response-schema
  - temporal
sources:
  - agent ae17b024-5287-4199-84d0-6cce3bd1765d
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
  - commit 73cdeae14c543adca645420887bdf787d24384d9
  - commit c65baa4f4
  - commit 949b4be32
  - PR #1511
repro: agents/tests/blackbox/workflow.blackbox.py::test_workflow_keyed_rejection_admits_already_polled_durable_feedback
status: fixed
---

## Problem

Comparison with the root schema standard exposed a sibling requirement-intake
gap. A rejection can persist its optional free text as a real USER row while
signaling only a request_id and rejection control response. Fetching that row
into context did not guarantee that schema refresh had accepted it. A venue
booking correction could therefore leave the prior native completion contract
active. A second case lost the final instruction in an A -> B -> A sequence by
treating repeated text as duplicate input.

The supplied Calendar incident used a keyed authentication response, as proved
by worker custody evidence in
[the peer resume case](2026-10-14-suspended-browser-resume-omits-user-instructions.md).
This archive does not assert that it used the rejection endpoint or that its
root events schema was wrong. Rejection and chronology failures here are
independently reproduced root-boundary mechanisms.

## Diagnosis

Path: attention rejection -> durable USER feedback and keyed control signal ->
root polling/context -> native requirement intake -> existing schema worker.
The earliest bad boundary is intake acknowledgment, not the DB row or rendering.
Context presence and schema acceptance are separate states. Durable identity
distinguishes repeated delivery of one input from a later user instruction with
the same wording; global text uniqueness cannot preserve intentional reversion.

PR #1511's baseline 73cdeae14 already accepts genuine keyed free text and updates
the root's native system/output contract. The residual local repair admits
durable rejection feedback whether it arrives through a new poll or was fetched
before its signal, and preserves source chronology when constructing the next
schema request. Control responses remain gate state rather than requirements.

Archive searches used rejection feedback root schema signal request_id and user
update during verifier stale completion. Existing purchase/payment cases are
relatives with different first bad boundaries. The original resume incident is
owned by the peer case; this is a separately proved intake defect.

The deepest owned cause is inconsistent event custody between keyed signals,
durable input and schema acceptance. The repair extends the existing native
worker rather than adding a classifier, generator or fabricated conversation
row. Golden custody analogs are the peer's inspected Codex
codex-rs/core/src/session/input_queue.rs:389, Hermes
agent/agent_runtime_helpers.py:3758, OpenClaw
packages/agent-core/src/agent-loop.ts:221 and Claude src/query.ts:1570: drain and
commit actual scoped input before dependent execution. No prompt edit is added.

## Solution

The current native candidate records accepted durable identities independently
from whether polling placed them in context. Rejection handling reads the
durable tail and admits unacknowledged real input before dependent verification.
Plain/keyed genuine instructions queue the existing coalescing schema worker;
empty responses and reserved gate-control values do not become schema feedback.
Ordered durable rows preserve A -> B -> A and same-timestamp distinct IDs.
Current schema changes update native workflow state and the actor contract
without synthetic USER schema rows or TOOL schema narration.

The current worktree extends integration base 949b4be32 atop the peer's later
native source c65baa4f4, including subsequent reviewed changes; 73cdeae14 remains
the earlier recorded causal baseline. The withdrawn
candidate 59fb6922b's generated schema-message approach is not
being deployed. The peer now forwards authored response bytes and their request
source separately from gate-control state. Root intake acknowledges the canonical
attention_response/request-ID event once across signal/row ordering, duplicate
physical rows and continuation. Distinct same-text attention events remain
distinct requirements. An authored control-looking word is genuine user input;
an explicit protocol-only marker remains control state. Native A -> B -> A
chronology is preserved without matching unrelated attention events by text.

The six event-ledger regressions initially passed only under a temporary peer
seam adapter; that was not public-path proof. After integration with c65baa4f4,
native-workflow-event-identity-public-postfix.log records all six public tests
passing, plus authored-message/protocol-only controls, without an adapter.
The accepted event ledger and original authored bytes survive continuation.
Public-source proof is distinct from the final owning workflow gate described
below.

Three permanent tests fail on the native baseline: already-polled rejection
feedback was ignored, unpolled rejection feedback was not admitted, and a
distinct durable reversion was dropped. Exact recorded command from the
native-coherence worktree:

    source agents/venv/bin/activate
    python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root . --baseline 73cdeae14c543adca645420887bdf787d24384d9 --runtime workflows.agent_workflow workflow test_workflow_keyed_rejection_admits_already_polled_durable_feedback test_workflow_keyed_rejection_polls_durable_user_feedback_without_schema_narration test_workflow_schema_requirements_preserve_distinct_durable_reversions

The identical invocation without --baseline loads the current runtime. The
runner loads git-show baseline source in an isolated module, using unchanged
permanent tests, assertions and fixtures. native-workflow-causal-before.log
records the three causal failures; native-workflow-causal-after.log records
the passes. Earlier native-workflow-{baseline,postfix}.log also retains failure
then pass evidence, together with keyed genuine-input and reserved-control
controls. These tests use real workflow intake and native refresh methods with
mocked activity results.

Canonical owning command, from agents with its venv activated:

    python scripts/run_blackbox_tests.py workflow

native-workflow-domain-final.log records one domain passed, zero failed, 35.5s.
After requirement-revision caller plumbing, native-workflow-domain-keyed-revision.log
records one domain passed, zero failed, 40.8s. These are recorded local results;
final source-contract changes require their own rerun. The normal deploy agents
coverage runner discovers the registered permanent tests.

The later native-workflow-domain-final-acceptance.log records one domain failed
in 104.8s, with the parked write-approval continuation fixture failing. Its
protocol-only approval omitted canonical user_message null and was interpreted
as legacy authored feedback against a no-fields generation stub; the new
acceptance guard correctly refused that unaccepted contract. Only the fixture
envelope was corrected to explicit null. All existing approval/session/handoff
assertions are retained. The identical canonical workflow command passes in
native-workflow-domain-final-acceptance-rerun.log: one domain passed, zero failed,
40.9s. A subsequently reproduced verdict/schema-wait ordering race was then
repaired; the final native-workflow-domain-final-wait-race.log reports one domain
passed, zero failed, 36.0s, including event custody, accepted-contract, caller,
persistence and final-wait acceptance coverage. The sibling verifier case
records the additional causal proof. Subsequent source changes require fresh
checks.

At 10,000 agents, intake reads and acknowledgments remain scoped to each root;
the existing schema worker coalesces revisions. History and source identities
grow with that root's real input, without cross-user subscriptions or fleet
scans. Continuation state must retain acceptance/source identity rather than
reconstructing it from whichever rows survived context compaction.

The case remains open pending rollout. The
deleted production Calendar agent was not rerun or modified by these tests.

### Request waiter publication ordering follow-up

Cycle 2 review (finding 4277021253) identified a remaining receive-boundary race.
The keyed receiver published `_signal_responses[request_id]` before awaiting
legacy rejection feedback polling. A concurrent request waiter could consume the
rejection while its durable USER requirements still had no admitted revision.
The earlier rejection tests awaited the entire receiver, so they could not
observe this intermediate state. This is a recurrence at the same intake owner,
not evidence that the deleted Calendar incident used the rejection endpoint.
Archive follow-up searches used `receive_user_response rejection request-scoped
wait` and `waiter released before durable feedback admission`; this case owns
the observed boundary.

Two permanent workflow tests invoke the native receiver with its external
message-poll activity blocked and an independent request-key waiter. Both fail
on 1ed6269b3ee7 with `request-scoped waiter consumed rejection before durable
feedback admission`. The identical tests pass after moving only response
publication and its log below existing authored/legacy feedback admission.
Success exposes the original authored bytes and revision before the waiter
runs; polling failure leaves the request unpublished and propagates the
existing error. The success control also repeats the canonical attention event
and verifies that its revision remains one. Existing explicit-null controls,
authored protocol-looking words and exact-byte tests remain unchanged.
There is no schema helper, payload, provenance, budget or model narration change.

Focused command, from the isolated response-ordering worktree:

    source agents/venv/bin/activate
    python .context/rejection-ordering/repro.py

The retained `before.txt` records two causal failures and three existing control
passes; `after.txt` records five passes using unchanged fixtures/assertions.
The full owning command from `agents/` is
`python scripts/run_blackbox_tests.py workflow`. It failed on the two new waiter
assertions before the fix (31.6s), then passed one domain with zero failures in
41.6s; the complete latter output is retained in
`.context/rejection-ordering/workflow-after.txt`. Both new tests are registered
in that normal deploy-owned workflow runner. Scoped Ruff, compilation and diff
checks pass. Production acceptance and the single combined rollout remain
pending the deployment owner.

## October 15 follow-up: preserve a fresh task's authored input boundary

Outside-diff review 5526868411 on frozen
`f2625c20ded63a76b625b526f95a23a9b5f90886` exposed a related intake defect.
A new task after a completed run correctly regenerated its initial schema from
the latest real USER instruction. Its first execute poll then fetched history
from the epoch, admitted prior-task USER rows as new feedback, and generated
another schema containing the old requirements. Independently, the schema
reload builder prepended the older stored goal and imported those historical
rows again. Seeding intake acknowledgments alone could not repair both paths.

At this existing fresh-superseded-start boundary, the workflow now records the
latest authored instruction as the task's schema base and acknowledges the
observed real USER prefix by canonical source identity. The schema builder
excludes that same prefix; the fresh base is already supplied separately.
Both values survive continuation. The canonical attention request ID prevents
a physical-row or signal retry of an earlier event from becoming new feedback.
An unseen source remains eligible regardless of its timestamp, and distinct
same-text events preserve A -> B -> A. Existing pending feedback is retained.
Ordinary resumes do not acquire a new task boundary. No timestamp cutoff,
second input transport, generated USER row or synthetic narration is added.

The permanent real-workflow fixture executes the first epoch poll, requires
exactly the initial fresh schema generation, and then independently reloads
requirements to exclude both the old goal and the earlier correction. From
`agents/`, the causal command is:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. --baseline f2625c20ded63a76b625b526f95a23a9b5f90886 --runtime workflows.agent_workflow workflow test_workflow_fresh_task_poll_and_reload_exclude_prior_requirements
```

It fails on f262 with `fresh execute poll readmitted previous-task requirements`
and passes unchanged after omitting only `--baseline` and its value. Combined
transcripts are `.context/root-review-causal-{before,after}.log`. A second
registered owning case preserves same-timestamp distinct sources, delayed
commits, attention retries, intentional repeated instructions, continuation and
normal-resume behavior.

Independent review also reproduced an attention signal delivered before the
startup snapshot established that boundary. Its durable row was excluded, but
its already-queued text could be appended again. The captured pre-ledger runtime
has SHA256 `37dd21a4c6a4e1a319cc0116b2554663cf8666f68f96241ecaa086c05965ad6d`.
On that source, the unchanged permanent case
`test_workflow_fresh_boundary_filters_only_proven_queued_feedback_sources` fails
with `a known pre-boundary signal consumed current-source coverage or
reintroduced historical requirements`. It passes after pairing native feedback
occurrences with their proven source keys and filtering baseline sources before
text-occurrence accounting. Unknown legacy text stays unclassified; genuine
distinct events with the same words and A -> B -> A remain intact. Continuation
preserves alignment even when rejecting a malformed non-string feedback entry.
The source snapshot and exact final proof logs remain private as
`root-preboundary-source-before.py`, `root-preboundary-source-final-red.log`,
`root-preboundary-source-green.log` and `root-preboundary-source-focused.log`.
An added fixture control initially lacked its local copy import; that setup
error was corrected and is not counted as the causal failure.

All five new regressions are registered in the normal owning runner. The final
full workflow and determinism command passes two domains in 38.6s, retained in
`.context/root-review-final-owning-v2.log`; the 37.4s run preceded the queued-source
repair. Scoped lint, compilation and diff checks pass. This is a related
fresh-task admission boundary, not a reclassification of the original Calendar
incident as a root rejection failure.

## October 15 follow-up: exhausted rejection reads must retain known input

Substantive review 5538604849 on immutable PR #1511 source
`4955bbc90c6f27e4e21baf9c3b70bbc37b1547c0`, discussion 4287248194, identified
an uncaught activity-read failure in legacy rejection intake. The actual
`receive_user_response` receiver awaited `_receive_rejection_schema_feedback`,
which awaited `_poll_messages` before admitting already-known context rows.
An exhausted `ActivityError` escaped before `_signal_responses[request_id]`
was assigned. Thus a failed supplemental read could suppress the rejection
response and skip an actual USER correction already present in context.

The new permanent cases reproduce that receiver-to-activity boundary with a
real Temporal `ActivityError` marked `MAXIMUM_ATTEMPTS_REACHED`. Both the
already-known-input case and empty-context case fail on frozen 4955 with
`durable USER poll exhausted retries`. The repair catches only that activity
failure, logs it, and runs the existing durable admission operation before the
receiver publishes the rejection. It does not invent missing feedback. The
existing later polling path admits a previously unavailable row exactly once;
the test executes it twice to prove source deduplication.

Cancellation and generation control remain errors. The existing cause-chain
utility recognizes direct or serialized application-error type names through
Temporal wrappers, and cancellation, sealed generations and handoff causes
are re-raised unchanged. Direct workflow RuntimeError remains outside this
catch; the earlier failed-intake waiter assertion is unchanged. The six lifecycle
controls require identical raised errors and no falsely published response.
This is an additional read-failure branch of the existing rejection-admission
case, not evidence that the Calendar incident failed with ActivityError.
No handler, backend, new poll, retry mechanism, fabricated USER/TOOL turn,
provider setting, score, or budget changed.

The three new cases are registered in the normal owning workflow runner.
Exact baseline command from `agents/` with the existing venv activated:

```bash
python /home/boxes/rose/.context/rca-ae17b024/run-selected-native-blackboxes.py --root .. --baseline 4955bbc90c6f27e4e21baf9c3b70bbc37b1547c0 --runtime workflows.agent_workflow workflow test_workflow_rejection_activity_read_failure_preserves_known_feedback_and_response test_workflow_rejection_activity_read_failure_defers_unknown_feedback_once test_workflow_rejection_read_does_not_swallow_cancellation_or_generation_fence test_workflow_failed_rejection_intake_does_not_release_waiter
```

The unchanged final fixture yields two causal failures and passing lifecycle
and direct RuntimeError controls. Repeating without `--baseline` and its value
passes all four; the three existing successful intake/order cases also pass.
Before/after evidence is retained in `root-rejection-poll-before.log` and
`root-rejection-poll-after.log` in the local RCA evidence directory. Archive
searches used `rejection poll failure response schema ActivityError` and
`request scoped waiter signal response durable context feedback`; this case
was the closest lead and owns the same admission boundary. Its native durable
admission and later `_poll_messages` are the direct implementation standard;
no second transport or external schema-generation analog is introduced.

The final full owning command `python scripts/run_blackbox_tests.py workflow
workflow_determinism` passes both domains with zero failures in 43.0s, retained
in `.context/root-rejection-poll-full-owning.log` in the isolated worktree.
Scoped Ruff, compilation, diff and 874-case archive checks pass. Independent
read-only review of the complete delta is clean. Prompt and trajectory guards
pass; the incremental agent-behavior guard flags the recovery change without
any approval or override supplied. The exact scoped snapshot is handed to the
same PR #1511 owner for the consolidated required decision and final release;
no paid probe, shared service/database change, merge or deployment ran here.

## Human feedback

The user asked to follow the root standard and implement missing support there,
with schema changes only when needed. The later instruction recorded by the
peer explicitly rejected harness injections and required preserving sent user
messages. Native requirement intake follows that direction.

## Reusable lesson

Acknowledge actual input events independently from context polling, preserving source identity and chronology before refreshing the native completion contract.
