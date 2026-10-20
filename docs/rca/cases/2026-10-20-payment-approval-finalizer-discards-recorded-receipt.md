---
id: 2026-10-20-payment-approval-finalizer-discards-recorded-receipt
date: 2026-10-20
title: Payment approval finalization discarded the recorded receipt before browser verification
surface: agents
component: spawn-browser-agent-v3 / service_crypto payment approval finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/service_crypto.py:1082 at 64e5cc2dd — finalize_parked_payment_card_approval_history replaces the recorded awaiting result with a minimal payment_card_ready result, dropping payment_request and current_url"
symptoms:
  - "Timeout after 904s (task timeout=900s)"
  - "Agent status: PAUSED (expected COMPLETED)"
  - "agent-payment-idempotent-abandonment"
  - "Browser verifier repeatedly scored 0.5 for missing request_payment_card receipt details and currency"
  - "awaiting_payment_card_approval became payment_card_ready without payment_request"
tags:
  - browser
  - payment
  - agentcard
  - verifier
  - receipt
  - approval-resume
sources:
  - agent 8395ca4b-f1d0-4516-802f-3525da69d6cb local candidate outcome
  - benchmark run d93e7651-a716-4527-8f10-88ab3c6c5c5d
  - agent fb3964fd-8a79-4cc8-ae5b-8449ebc50027
  - task 50a54f59-4d42-51a8-af7d-7810ec6a5047
  - commit 64e5cc2dd83dfc346797b97e7c0f5fd749713250
  - PR #1552 initial deploy gate discovery at64e5cc2dd; payment candidate was excluded pending separate approval
  - benchmark run 6a650338-5a33-41fa-9e7d-32530efe8315
  - agent fb3964fd-8a79-4cc8-ae5b-8449ebc50027 evidence .context/rca-915ab997/browser-payment-failure-triage.txt
  - agent fb3964fd-8a79-4cc8-ae5b-8449ebc50027 timing .context/rca-915ab997/browser-payment-timing-audit.txt
  - agent fb3964fd-8a79-4cc8-ae5b-8449ebc50027 candidate .context/rca-915ab997/browser-payment-verifier-candidate.patch
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_payment_finalizer_preserves_receipt_in_short_verifier_history
status: open
---

## Problem

At immutable browser deploy HEAD `64e5cc2dd`, the unchanged four-task AgentCard
sandbox gate produced two passes, one failure, and one standing-policy skip.
`agent-payment-idempotent-abandonment` failed its existing 900-second budget:
the poller reported 904 seconds; the broader task lifecycle measured 925.6
seconds. The original agent remained PAUSED rather than COMPLETED. These are
separate clocks, not three different configured limits.

The first browser selected the requested three products, obtained the approved
$43.96 card, entered its private fields, and left checkout unsubmitted. Four
completed verifier calls scored 0.5 while requesting nonsecret receipt details
and currency. The final verifier call was still in flight when the benchmark
paused the root; it is not a fifth completed rejection.

This is distinct from the original browser startup incident on agent
`915ab997-c174-4297-80ac-15347120342f`. The failed payment browser reconnected in
1.596 seconds and did not record the original BrowserStartEvent/TabCreatedEvent
startup timeout.

## Diagnosis

Archive searches used literal terms
`awaiting_payment_card_approval payment_card_ready finalize_parked_payment_card_approval_history`
and behavior terms
`verifier missing merchant currency approved card request 0.5 abandonment`.
The full Solution and Human feedback of
`2026-09-29-browser-payment-approved-request-omitted-from-verifier` were read.
It is a close relative, not proof that its original first-bad boundary recurred:
that case omitted the action-history entry before pause; this execution records
it correctly, then loses its payload at approval finalization. Its regression
preconstructs an approved receipt and does not cross the destructive finalizer.
The prior case also rejected synthetic order summaries and browser nudges.

Critical path: validated `request_payment_card` result -> parked tool transcript
and action history -> approval/mint ->
`finalize_parked_payment_card_approval_history` -> resume completion ->
`build_browser_verifier_context` -> verifier -> repeated completion attempts.
At `handler.py:11205`, the actual awaiting result is recorded. The captured
`write_lock_notification_fork_3` request contains merchant, USD, line items,
fees, subtotal 3600, tax 297, shipping 499, total 4396, and current URL.
Finalization at `service_crypto.py:1082`, `:1092`, and `:1108` substitutes the
minimal ready result in both histories and both saved transcripts. The first
resumed `browser_use_step_4` tool result has readiness and last4 2828 but no
receipt. `service.py:351` consumes the already-damaged history; changing its
window would not restore these fields.

The independent timing audit counted 34 completed LLM attempts totaling
824.043 seconds, plus 17.061 seconds of the last in-flight verifier: 841.104
seconds of the 908.387-second worker-start-to-pause interval. Four completed
verifiers consumed 342.429 seconds. The benchmark task deadline expired;
no provider-call deadline, Temporal activity timeout, or event-loop deadlock is
established. Approval itself finished in 262 ms. Increasing a timeout would
leave the receipt-loss boundary intact.

This proves the data-loss mechanism and explains the repeated missing-receipt
judgment, not that receipt preservation alone makes the full benchmark pass.
The verifier also requested purpose/idempotency evidence not represented by the
current request schema. The 30-action retention predicate recognizes approved
status rather than payment_card_ready, but this trace had only 20 browser steps;
that is a separate potential edge, not this first-bad boundary.

## Reproduction and verification

Executed scratch regression:
`browser-deploy/.context/browser-payment-receipt-repro.py` under
`.context/rca-915ab997/`. It loads the actual captured awaiting tool result,
passes it through the real finalizer, ActionHistory restoration, resume
completion, and verifier-context builder. File listing is mocked empty; it
makes no model/provider calls and does not execute a payment or booking.

From `.context/rca-915ab997/browser-deploy`:

```bash
source .context/browser-gate-env.sh
PYTHONPATH="$PWD/agents" python .context/browser-payment-receipt-repro.py
PYTHONPATH="$PWD/agents" python .context/browser-payment-receipt-repro.py .context/browser-payment-service-crypto-candidate.py
```

The active code exited 1, reported `receipt_preserved_in_all_four: false`, and
raised `AssertionError: Approved receipt is lost across finalization`.
The same test with an isolated candidate source copy exited 0 and reported
`receipt_preserved_in_all_four: true` and
`PASS: captured receipt survives actual finalization -> completion -> verifier-context boundary`.
Both executions took approximately half a second in the original tool run.
The test also asserts repeated finalization is idempotent, call identity is
retained, receipt/item/currency fields reach verifier context, and synthetic
private card values do not reach that context.

Exact source/result hashes and paths are recorded in
`.context/rca-915ab997/browser-handoff-manifest.json`.
The candidate patch SHA-256 is
`bdc17a5189b282698f5c57e2bc136ce9241fbd88a71a41df206b984552b1c3b5`.
The unchanged failed benchmark JSON SHA-256 is
`6dc3eec041cdb0c00e8034795a6674c9a4a157d98b2330f568dfab48bfdfdfda`.
The baseline runtime file remains SHA-256
`1c381989fbfa46c4ed52cd895017f39c16030135f7a6ee2926197381bb21103d`.
The initial scratch proof was later promoted into the registered owning
regression listed in frontmatter, with unchanged before/after assertions.
The follow-up below records the exact local benchmark outcome. No healthy gate
cohort was repeated for this archive entry.

Independent adversarial review independently reproduced the exact candidate
(approximately 0.49 seconds per invocation) and accepted this narrow transport
repair. It did not approve deployment. Additional real-helper probes verified
canonical ready-field precedence, idempotence, supplied call identity and existing
secret projection. The reviewer also reproduced an independent long-history gap:
ready receipts are not retained past 30 subsequent actions because the existing
predicate recognizes only approved. That hunk is outside this candidate. Legacy
fields outside the canonical ready keys can remain; the captured valid producer
has only status, receipt and URL. No general stale-field sanitation claim is made.

The failed benchmark FE link and last trajectory call were durably published and
verified in a fresh browser by publish_evidence_links.py; all browser terminal and
recording completeness checks for this benchmark agent passed. The parent receipt
is `.context/rca-915ab997/browser-payment-evidence-publication.log`. This does not
resolve the original production agent's separate active-browser recording gap.

### Local candidate outcome follow-up (2026-10-20)

The parent explicitly authorized a fresh local candidate checkout from
`64e5cc2dd`, the exact reviewed preservation patch, an additive registered test,
and the unchanged idempotent-abandonment task before requesting deployment
approval. No approval was requested or received, and PR #1552 was not changed.

Candidate checkout: `.context/rca-915ab997/payment-candidate`, branch
`experiment/payment-receipt-915ab997`, uncommitted changes over `64e5cc2dd`.
Only the reviewed runtime diff was applied. Resulting service file SHA-256:
`1daf2f0271a004791f1af42c297328dabef8b8640e9a014e5661539d7c0120e2`.
The new owning test is registered in `run_all_tests`; the test file SHA-256 is
`64a5c52356f91f02ae8c0addd7a3112423998bba480eee8f274ed64ffc4ddec9`.
Existing assertions were not weakened.

The identical registered-test runner, before and after applying the patch:

```bash
PYTHONPATH="$PWD/agents" /home/boxes/rose/agents/venv/bin/python .context/run-payment-finalizer-regression.py
```

Baseline: exit 1, `actual_short_verifier_has_receipt=false`, assertion
`approval finalization lost receipt before the actual short-history verifier context`.
Candidate: exit 0, `actual_short_verifier_has_receipt=true`.
Measured test-body time was 0.314995 seconds red and 0.064237 seconds green;
module import is excluded. Four unchanged neighboring controls also passed.
The test now uses the actual captured tool call ID and validates all four
storage adapters plus the real short-history verifier-context builder.

The exact unchanged task command:

```bash
bash scripts/run-bench --local agent-payment-idempotent-abandonment --bootstrap --max-concurrency 1 --no-dashboard
```

Run `d93e7651-a716-4527-8f10-88ab3c6c5c5d`, agent
`8395ca4b-f1d0-4516-802f-3525da69d6cb`, reported **PASS in 255.8 seconds**.
The original task's 900-second limit, prompt, evaluators, fixtures, tool counts,
price limit and acceptance criteria were unchanged. The original 925.6-second
failure remains the before outcome; it was not rerun. Actual resumed tool
results retain `payment_request` and `current_url`. Both browser verifier calls
returned score 1.0 on `gpt-6-sol`, with receipt/currency/total present in context.
The first verifier dump SHA-256 is
`d1e45caefc94a2248e0a0a544667c9a78b28f8d91c3216fd5d495ea97bf60792`;
the second is
`3ac3f7dc974111b52913e204f705c86ef7b255e388d7615c97a61ad39c60557a`.

Environment limits are explicit: Python used the same verified baseline
virtual environment. Supported fresh Node preparation resolved five different
package entries, including backend Zod 3.25.67 versus baseline 3.25.76; frontend
Zod remained 4.6.5. The comparison is saved in
`payment-npm-dependency-comparison.json`. This is not a controlled whole-system
performance experiment, and the runtime difference must not be advertised as
measured time savings caused solely by the patch. No schema source hunk changed.

The canonical runner then exited 0, verified exact-root provider cleanup,
and recorded `cleanup_verified` plus a version-2 clean stack receipt. The three
owned service ports were closed. The final run JSON SHA-256 is
`06ee383d1932f8249b22b063088fa0ee3713fb753229bf5b1ee17b8ac64b7148`.

The evidence publisher was run without skip flags and exited 0. It verified the
FE in a fresh browser with 104 messages, enforcing the browser terminal and
attached-recording gate. Durable FE: https://www.roselabs.ai/?agent-id=8395ca4b-f1d0-4516-802f-3525da69d6cb#benchmark-share=d93e7651-a716-4527-8f10-88ab3c6c5c5d.1795057963.27f41b1599c4400f6bef7dccadb09e384d05d25c7a1352f4cdaf2bb690b6b863
Last call: `completion_summary`; the publisher manifest and HTTPS rendered dump
are retained under the candidate worktree `.context/rca_evidence/8395ca4b-f1d0-4516-802f-3525da69d6cb/`.
This verifies the candidate run only, not the original production booking. Prior $43.96 unreleased/refund-pending liability
belongs to the earlier standing-skip run and remains explicit.

### Focused pending-completion implementation (2026-10-20)

After the user's implementation authorization, the existing candidate retained
the A2 finalizer patch and added one runtime line in
`_resolve_payment_card_tool_result_for_resume`: spread the original pending
result before its authoritative ready fields. This alternate helper otherwise
also lost `payment_request` and `current_url`. The normal real A2 path usually
finishes the result earlier; this helper finding is not a second demonstrated
cause of the original captured failure.

The registered test `test_payment_completion_survives_hydrated_actor_and_verifier`
failed on the A2 baseline at `alternate approval completion lost the actual
receipt` (0.104063 seconds) and passed unchanged with that line (0.163666
seconds). It uses the existing encrypted snapshot store, the original call ID,
actual actor and verifier builders, receipt facts, safe refs and repeat-completion
checks. The no-event next-message equality control passed on both revisions;
an ordinary handoff is not diagnosed as broken by this reproduction.

The additional registered
`test_completed_payment_no_event_drain_preserves_next_actor_request` passed for
inline and encrypted snapshots, carried payment bindings, original serialized
completed tool content, unrelated turns/history and a screenshot. These compare
the same next actor messages under fixed runtime inputs, including the system
prefix. They do not prove full provider request/configuration pinning, arbitrary
legacy-history recovery or every live startup/privacy path.

From `payment-candidate/agents`, the normal owning command
`./venv/bin/python scripts/run_blackbox_tests.py spawn-browser-agent-v3`
passed in 92.4 seconds. An earlier invocation from repository root failed two
relative-path source checks; that attempt is retained. Correcting the working
directory resolved the invocation error without weakening tests.

The unchanged local `agent-payment-idempotent-abandonment` task passed in
254.1 seconds on this final runtime: run
`2023ea15-dba3-4455-bc3e-4d104d3e4d96`, agent
`fad65dad-5d2c-4202-b1e4-37a4dd96101e`. Both browser verifiers scored 1.0.
The same task command, 900-second limit, task bytes, evaluators and fixtures
were retained. The final runtime patch SHA-256 is
`e4502ba7a6a60876422d09bfb65d861afefc01beea991c5304486755c9a582b6`;
registered-test patch SHA-256 is
`a444b2fabbd3b547a7cac3b4c75325ba6c7a3af8bb78bc84831f6fbeeed1fe52`.
Independent changed-byte review accepted that exact snapshot and independently
repeated the causal failure/pass plus eight candidate controls.

The evidence publisher verified 111 messages in a fresh browser with every
browser terminal and recording gate enforced. Native stack/benchmark identities
were absent, cleanup receipts clean, and provider-root cleanup passed. The new
sandbox purchase cleared, its funding was consumed, and its card closed with
zero balance. The earlier separate $43.96 liability remains open.
Full source binding, unchanged-task proof, durable FE/dump links and cleanup
receipts are in `.context/rca-915ab997/resume-impl-final-handoff.txt`.

The supported producer parks immediately after one pending call; successful
real mint/reuse validates complete private details upstream. Inconsistent legacy
multi-pending histories and last4-only direct finalizer calls remain separate
defensive risks. Existing simulator compaction and the long-history verifier
window are outside this repair. No new event store, synthetic actor message,
model, schema, prompt instruction or timeout change was introduced. Deployment
of these runtime context bytes required the exact final approval snapshot, subsequently approved as A3 below.

## Solution

Approved A3 candidate, now applied in the isolated PR #1552 deploy worktree; production rollout is pending: preserve the existing validated result payload when
transitioning it to payment_card_ready, with the canonical ready fields taking
precedence. Apply that same transition to action history, simulated history,
and both saved tool transcripts, plus the existing alternate pending-completion
helper. Retain existing malformed-content behavior.
This carries the original recorded receipt rather than inventing a summary,
new directive, tool call, request schema, or terminal policy.

This is a data-preservation change, but it changes runtime context bytes read
by the model. `/deploy` Step 0p therefore requires fresh snapshot-specific
approval. The already-authorized viewport patch does not grant that approval.
The parent owns the approval request. During the initial handoff, neither the candidate nor additional
runtime source was applied or committed. The later local-only authorization
is recorded above. The subsequent exact A3 deployment approval is recorded under Human feedback.

The follow-up local experiment registered the owning regression and ran the
unchanged task, as recorded above. Snapshot-specific A3 approval has now been
received; applicable deployment gates and rollout remain pending. Keep this
case OPEN until those deployment steps complete; candidate browser terminal and
recording evidence passed as recorded above.

Read-only golden comparison found no native payment-card-approval analogue in
any of the four references. Relevant general protocol boundaries are Hermes
`agent/tool_dispatch_helpers.py:432-455` (actual content with canonical call
ID), Codex `codex-rs/core/src/mcp_tool_call/conversation_history.rs:153-170`
(actual input/result retention), OpenClaw
`src/agents/session-tool-result-guard.ts:193-197` and `:488-492` (explicit
transformation/persistence boundaries), and Claude Code `cli.js:38` (paired
tool_use/tool_result). These support retaining result identity/data, not a
claim that the reference harnesses implement this payment repair.

All four benchmark roots had verified provider cleanup; local benchmark and
stack receipts are clean. The separate abandonment task remains a loud standing
release-stall SKIP with $43.96 unreleased and refund pending. It does not waive
this idempotent task failure or establish financial cleanup.

## Human feedback

The parent required the worker to continue pending local gates and cleanup,
then return at the real prompt-approval stop with an exact candidate diff and
unchanged task outcome artifacts. The parent required this durable OPEN record,
no additional source commit beyond immutable tested HEAD, no relaxed gate or
timeout, and no claim that local proxy evidence proves the original booking.
The parent owns approval and durable FE recording validation. Earlier delegated
read-only investigation restrictions came from the parent assignment, not a
user ban on future implementation after approval. The original live agent,
its later browser, Freedom, and all unrelated runs remain protected.

The follow-up parent directive allowed only this local experiment and required
an unchanged outcome before a deployment approval packet. No broader payment,
long-history, stale-field, model, schema, deadline or terminal change was authorized.

The user then questioned whether a browser restart should preserve all context
AS IS instead of piecewise saves, and asked whether syncing latest main already
fixes this. The parent fetched main at ab518bf5a and verified the owning
resume-store, finalizer, handler and remote-profile sources are unchanged from
the original baseline. The existing resume store already preserves the complete
serialized transcript; the candidate repairs a later destructive finalization
update across existing representations. This question is not implementation
approval, and no user decision on A2 has been recorded.

The user further asked why a restart changes trajectory at all and what other
paths change it. The read-only independent inventory and local probes are in
`.context/rca-915ab997/resume-history-audit-review.txt` and
`resume-history-probes.json`. Important precision: A2 proves loss in the saved
pending result and the resumed request, not that this result had already been
delivered to the same browser actor before it was completed. Conditional privacy
projection, simulator compaction and ordinary per-call result filtering are
additional mechanisms; they are not established causes of this incident. The
existing snapshot integrity checks do not enforce immutable previously sent
provider messages. No source change or A2 approval followed this audit.

The user subsequently authorized implementation with “dont overengineeerthis,
but yes continue impl” and clarified that accepting the request should finish
the pending tool and populate its data. The implementation scope is therefore
the existing pending-call completion contract: preserve the original receipt,
populate the actual completion fields once, and leave completed and unrelated
messages unchanged. The earlier infinite-time architecture proposal is not the
implementation plan. No new event store or general browser-runtime migration
is needed for this repair. Snapshot-specific deployment approval is separate
from this authorization to implement and verify locally.

The user explicitly approved the final A3 deployment snapshot in chat. The
approved runtime patch SHA-256 is
`e4502ba7a6a60876422d09bfb65d861afefc01beea991c5304486755c9a582b6`.
The parent recorded approval on 2026-10-20 at 21:19:44 UTC and resumed the
existing PR #1552 deployment. This approval replaces the earlier A2 packet;
it does not approve the separate attachment candidate or broad architecture.
Keep status OPEN until the actual rollout and production checks are complete.

## Reusable lesson

Preserve the validated payload and call identity when completing a parked tool result, and test the actual approval-finalization transition before relying on verifier history fixtures.
