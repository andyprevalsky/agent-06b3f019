---
id: 2026-10-13-fundraising-funnel-outcome-replay-gap
date: 2026-10-13
title: Fundraising stops at initial inquiries while the causal outcome replay remains open
surface: harness
component: wmh-fundraising-funnel
classification: unresolved
problem_class: other
first_bad_boundary: Unproven; earliest observed candidate is native revision2 returning no verified warm leads, followed by revision4 returning an incomplete company dossier; neither is proven to cause the entire failed fundraising outcome
symptoms:
  - No investor lead could be promoted to a fully verified actionable warm lead
  - 8/23 children failed
  - Timeout after 3600s (task timeout=3600s)
  - No message was sent
  - No current, independently verified customer count
tags:
  - wmh
  - fundraising
  - outreach
  - research
  - outcome-replay
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - benchmark run f0a05573-f50e-49c2-b3c9-43b3b90dfbf9
repro: none-recorded
status: open
---

## Problem

The unchanged `raise-5m-rose-labs-brex` task exhausted its authorized 60-minute
execution window with no commitments, signed instruments, pending wires or
settled proceeds. Its private native retirement joined session
`69eeb4a4a80d4975af6c7998ba7086b8` at revision 414. There were 283 simulated
Explore boundaries, 121 browser boundaries, 9 code boundaries and one startup
notification. There were no direct message-transport-send transitions and no
completed browser-email send. Initial inquiries increased, but the round did
not reach qualified investor conversations, meetings, commitments or financing.

Eleven selected native observations report form/intake submissions at ten
distinct firms: revisions 54, 57, 63, 76, 88, 90, 97, 100, 114, 206 and 265. NEA appears
twice. These are simulated form observations, not ten qualified investor
conversations. Later receipt audits often report an absent corroborating record
or an unverified route; the audit retains both observations rather than rewriting
the original receipt. Ten final scheduled-event descriptions say a firm *may*
review or respond. They are neither scheduled outgoing emails nor guaranteed
investor replies. Automated acknowledgment/transactional traces are not human
interest or a commitment.

The root's 23-prospect fan-out started at 03:48:33.007Z and returned at
04:43:04.922Z: 3271.915 seconds, or 54m31.915s. That is 89.55% of the reported
3653.6-second task duration. Fifteen firm children completed and eight failed.
Those eight children account for 279/414 native transitions (67.39%): 201
Explore, 69 browser and 9 code. First Round and Initialized account for 51 and
67 transitions respectively. This is concentration of recorded work, not proof
that every such transition was unnecessary. All children eventually settled;
the trace does not establish a fan-in deadlock. A separate header-only warm
item produced one child that correctly performed no outreach.

The durable run replay is
https://www.roselabs.ai/?agent-id=882b536f-5210-4c83-bf10-f2b4ce034228 .
The original full run JSON, all 25 agent dumps, native predictions and retirement
are preserved in the authenticated private Run13 result/supplement archives
referenced by PR #1453's preservation receipts.

## Diagnosis

This is an **open outcome investigation**, not a proven diagnosis or a fixed
benchmark. The critical path is original user goal and fixed initial state →
real planner and DAG → simulated dossier/pipeline research → 23 real
firm-specific agent loops → simulated route/preflight/send/response observations
→ child verifiers and fan-in → root reconciliation/verifier → unchanged
benchmark terminal check. The archive, full transcript and native transition
ledger were read before selecting possible boundaries.

Observed blockers have different scopes:

- Revision 2's pipeline audit finds no fully verified actionable warm investor.
  It does not prove the recovered real fixture has no investor history. The
  actual root planner input contains recent-message lookup leads, a deck link
  and a meeting mention; complete source threads/headers and current status
  still require read-only verification. Whole simulated Explore does not
  perform the real fixture search. The separate message-grounding RCA owns
  that data-to-simulation boundary.
- Revision 4's dossier does not establish a current approved deck, legal entity,
  current metrics, cap table, financing instrument/terms or detailed use of
  proceeds. These are generated virtual observations, not proof that the
  production documents are missing. Revision 413 explicitly blocks a detailed
  YC application on those unknown required facts. Revision 414 reports an
  accessible deck but no source-verified version/current approval or terms.
- Missing detailed company material did **not** categorically prohibit initial
  outreach. The actual delegated goal allowed conservative introductions with
  the public site when collateral could not be verified, and the eleven form
  observations contain such introductions. Do not make approval of an optional
  deck a blanket prerequisite for those channels.
- Revisions 407 and 409 report unrecoverable recipient/firm/current thread
  status, so no email was sent. Revision 408 respects an observed prior decline;
  it is a valid business constraint, not a broken tool requiring forced success.
- The eight failed children repeatedly seek positive reference fields and reach
  their existing 25-call execution budget. The separate
  `2026-10-13-execute-evidence-scope-discarded-user-specification` case owns the
  local causal proof for missing original user specification in verifier
  requests. This funnel case does not duplicate that defect or attribute all
  later research to it without a matched behavioral replay.
- The final root verifier reports 100% for grounded zero-dollar fields. The
  canonical task/schema/evaluator require at least $5M, so that local score is
  not round completion. The exact root verifier request/output is preserved
  privately. Inferring why the model gave that score still needs controlled
  replay; the verifier-context workstream owns its input-contract evidence.

What is proven here is the funnel deficit and the exact recorded branch/blocker
population. Where and why the complete trajectory first goes wrong remain
unproven. The Step5a ladder stops before naming sparse company facts, model
capability, contact-route conservatism, fan-in design or response probabilities
as the sole owned cause. The model-intelligence classification is not justified:
no exact old/new model-only replay was authorized or executed.

Archive searches were `No fundraising outreach emails were sent during this
run` and `fundraising research loop no outreach missing pitch`.
`2026-10-06-wmh-contact-lookups-lack-target-resource-grounding` is a relative
concerning public resource prediction and historical policy controls;
`2026-10-01-explore-kept-researching-after-required-evidence` is a relative
concerning repeated research without causal proof. Neither supplies a diagnosis
for Run13. The April 7 planner-registry omission is also a relative: this run's
planner and delegated goals explicitly include outbound outreach, so its
invisible-tool boundary is not established here. No historical case was altered.

Golden references were inspected locally before considering a change:

- `claude-code-src/src/tools/AgentTool/prompt.ts:103` requires complete context
  for a fresh child, including purpose and what has already been learned.
- The local read-only OpenClaw reference
  `src/agents/tools/sessions-spawn-tool.ts:153` accepts an explicit task, while
  lines 217–222 retain inherited sandbox policy and an explicit context mode.
- The local read-only Hermes reference `tools/delegate_tool.py:241` builds a
  child prompt from goal plus context; lines 617–622 distinguish isolated child
  work and one-shot join from asynchronous completion delivery.
- The local read-only Codex reference
  `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:172` uses first completed
  child results and gathers other already-ready finals, retaining pending work.

These references support faithful child context and explicit result ownership.
They have different join models and provide no universal financing policy or
proof that Rose's all-child fan-in is defective. No runtime nudge, guaranteed
send, cap increase or fundraising-specific routing rule follows from them.

## Solution

No prompt, seed, benchmark, evaluator, schema, probability, step cap, recovery
or terminal semantics changed in this workstream. No live model/provider call,
benchmark, merge or deployment was made. No invented company facts, investor
relationship, reply, interest, commitment, signing authority or funding were
added.

Safe preparation is complete under private
`.context/whm-migration/rca-20261013/outreach/`: a full transition index with
original selected observations, source-file hashes, per-agent funnel counts,
exact root verifier capture and `company-authority-inventory.json`. The latter
separates fixed task/seed facts, captured real account-context lookup leads,
generated virtual observations and source-unknown company fields. Legal entity,
current metrics, financing terms, cap table and private-material authority are
left `null`; no predictive dossier is promoted to production company truth.
Channel requirements separately cover minimal public introductions, verified
warm follow-ups, detailed applications and financing close. Eleven accepted
minimal forms remain evidence that optional private material is not a universal
initial-outreach gate.

Executed offline command, with the pinned agents environment activated:

```bash
source agents/venv/bin/activate
python .context/whm-migration/rca-20261013/outreach/audit_outreach.py
```

It completed in 0.26s, reporting 414 world steps, 279 failed-child steps,
3271.915s fan-in, 11 submission records and 10 scheduled events. The private
audit records hashes of the original run, native retirement, original initial
state and exact root verifier. This is reproducible record analysis, **not** an
owning-boundary failing/passing regression or benchmark outcome proof.

Next preparation is to use the recovered full-history fixture through its
existing read-only owning search path, bind original message IDs/body hashes,
sender/recipient identities and snapshot revision, and reconcile the actual
investor threads/materials into the private inventory. Missing values stay
unknown. Any proposed per-run context/initial-state change must be a concrete
reviewable diff; it must preserve the unchanged task and evaluator, immutable
native artifact/policy, sample-once replay keys, shared state and researched
distribution examples. The narrow source/context defects under separate RCAs
may inform that proposal but do not promise an investor response or a close.

Before claiming this funnel failure fixed, an isolated causal reproduction
must fail before and pass after an approved repair; the exact unchanged local
`raise-5m-rose-labs-brex` task must also fail before and pass after. Another paid
comparison requires explicit new authorization. Those gates are open. No
10k-agent runtime behavior changed; the audit reads only this preserved run and
does not add a concurrent planner, controller or global routing path.

The separate `2026-10-13-response-schema-validation-omits-field-descriptions`
case proves a validator annotation-loss mechanism and preserves its own open
HTTP/persistence/model-outcome gates. It is distinct from USER-context loss;
neither is established as the sole cause of the root's zero-dollar 1.0 score.

## Human feedback

The user required every iteration to explain realistic progress toward closing
the round: warm connections, sufficient outreach, scheduled follow-ups and
actual downstream stages. They rejected equating zero cash with zero trajectory
progress and required the stage estimate to be the first scorecard number.
They authorized one 60-minute Run13 and subsequently asked that each reported
issue be tackled by a subagent with `/rca`. Existing instructions prohibit new
paid trials without approval, merging/deploying, fabricated original receipts,
prompt/benchmark changes merely to pass and invented private/company/funding
facts. No new trial was authorized during this offline investigation.

## Reusable lesson

Audit the source-backed fundraising funnel and channel-specific authority separately from generated observations, verifier field scores and cash completion, and keep the outcome RCA open until an unchanged causal and benchmark replay proves the repair.

## Run14 milestone audit (2026-10-13)

Root `f1f436c9-8c1e-43a9-bf25-d4613c94e441` failed its 60-minute window
after 3691.4s, with 151 committed world boundaries. Those are 113 explore,
33 browser, two message-transport sends and three notifications. Eighty-four
boundaries (55.63%) are deliberate no-reply wait_for polls spanning 7.03
virtual days; they are not 84 distinct research successes. Three children
completed; the prior child 25-step-cap failure did not recur.

The stage proof finds three emails across two recipients and one generic
firm form inquiry. Two emails went to an investor named Grant; this is a
person and must not be misreported as government grant funding. The later
browser email has no literal stable sent-message ID in the original
observation. Sixty-three targeted historical message matches support the
warm-introduction and scheduling paths. There are no new substantive replies,
held investor meetings, commitments, signatures, incoming wires or proceeds.
One historical accepted meeting predates this run and is not a new milestone.

The scorecard's approximate 22% is an initial-outreach milestone estimate
within the same 20–25% stage band, not a calibrated unique number or money
percentage. Outreach was more concrete than Run13's zero emails, while
there is no proved advancement into a later fundraising stage. The literal
USER goal still drops at the execute-verifier evidence slice, but approved
response-schema descriptions carry the >=US$5m success criteria. Actual
verifier zero correctly rejects zero proceeds, so no false-success recurrence
is proved. The previously unapproved goal-filter patch stays unapplied.

No causal new trajectory fix is proved by this audit. Do not force positive
outcomes, substitute softer criteria or rewrite research examples. Full
static Tamy network packets (2225 people ×33fields) in the actual first paid
native request match the approved packet byte-for-byte; the frozen and seeded
fixtures each retain all 42910 Tamy message records. Private diagnostics,
eight owning controls, original message matches and source hashes are under
`.context/wmh-resume-generation1/run14-grounded-retry60m/rca-progress`.
