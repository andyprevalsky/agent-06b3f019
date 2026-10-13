---
id: 2026-10-13-execute-evidence-scope-discarded-user-specification
date: 2026-10-13
title: Execute evidence scoping discarded the USER task before completion judging
surface: agents
component: verifier-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py _filter_context_for_execute_verifier slices away the USER task before the first EXECUTE tool
symptoms:
  - "EXECUTE ended: max_iterations"
  - "Max Steps Reached"
  - "The supplied goal does not explicitly authorize negative findings"
  - "Original USER goal was omitted before verifier in 8/8 captured children"
tags:
  - verifier
  - context-scoping
  - original-goal
  - step-budget
  - wmh
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - benchmark run f0a05573-f50e-49c2-b3c9-43b3b90dfbf9
  - task raise-5m-rose-labs-brex
repro: none-recorded
status: open
---

## Problem

Run13 finished its authorized 60-minute execution window without raising the
round. Eight **general-purpose investor children**, rather than eight Explore
activity loops, ended with `max_iterations` after exactly 25 saved terminal
`execute_loop` LLM replies each. A terminal model reply is not proof of useful
fundraising progress. Their 37 explicit completion attempts plus eight
final cap verifiers all returned 0.5. Every one of those 45 captured verifier
requests omitted the original USER task, while the corresponding execution
requests retained it. A whole-tree audit found the goal absent in all 67
retained execute-verifier calls, including the completed root and its 16 completed descendants;
therefore absence is not itself proof of failure causation. The actual child
task allowed: “If no verifiable route,
report blocker rather than inventing one.” Some captured feedback instead
stated that the supplied goal did not authorize negative findings, or demanded
positive contact, send, written commitment and funding-date evidence.

| Assigned firm | Wall seconds from creation to stop | Execute calls | Completion attempts before cap | Final/total verifiers | Explore/browser/code calls | Wait calls |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Pear VC | 745.845 | 25 | 2 | 1/3 | 17/6/2 | 0 |
| Costanoa Ventures | 760.266 | 25 | 4 | 1/5 | 11/11/2 | 0 |
| Air Street Capital | 804.445 | 25 | 6 | 1/7 | 12/7/1 | 1 |
| Zetta Venture Partners | 1125.351 | 25 | 4 | 1/5 | 11/8/2 | 1 |
| Unusual Ventures | 1369.063 | 25 | 5 | 1/6 | 13/9/1 | 1 |
| Craft Ventures | 2906.696 | 25 | 7 | 1/8 | 11/14/1 | 1 |
| First Round Capital | 3129.489 | 25 | 5 | 1/6 | 10/7/0 | 3 |
| Initialized Capital | 3251.169 | 25 | 4 | 1/5 | 12/8/0 | 3 |

The child traces contain useful firm research, route searches, privacy-preserving
correspondence checks, attempted submissions and receipt verification. They also
contain repeated route investigations after earlier negative findings: 160 tool
calls followed the first rejected completion across these children. That count
is chronological, **not** a claim that all 160 calls were duplicates or useless.
Independent routes and receipt contradictions justified some further work.
All eight saved child records retained partial structured output; no loss of
their partial result was established.

The complete original 540-record native prediction census attributes **92
rejected prediction attempts** to these exact eight actor UUIDs: Pear 15,
Costanoa 13, Air Street 9, Zetta 9, Unusual 9, Craft 5, First Round 15 and Initialized 17.
Attribution reads `candidate_response.tool_calls[0].arguments.agent_id` from each
original request and independently matches its call ID to that child's complete
saved TOOL cards. All 92 matches were confirmed. These comprise 82 JSON syntax
rejections (68 missing-comma, 14 extra-data) and 10 protocol rejections (five
repeated keys, two observation/identity mismatches, three probability-sum failures).
This is separate evidence from the normal 25-turn stopping mechanism; overlap
alone does not prove those rejections caused the step-limit failures.

The same eight actors have 279 committed native world transitions: Pear 23,
Costanoa 24, Air Street 20, Zetta 26, Unusual 28, Craft 40, First Round 51 and
Initialized 67. Separately, their saved transcripts contain 357 distinct TOOL-card
IDs across 1055 TOOL rows. Rejected attempts, transcript cards and committed
transitions count different objects and must not be interchanged. Three rejected
operation IDs were absent from final committed history (two Pear, one Air Street).
The First Round actor also has one validated prediction attempt beyond its 51
committed transitions; validation alone is not a committed world step. Saved
child LLM replies, repeated completion feedback and the final cap are directly
recorded. No activity StartToClose timeout caused these eight terminals.

The earlier private direct-model-call audit counted 71 rejections because it
omitted call IDs generated by `wait_for` checks; this case additionally miscopied
that number as 81. Both defects were corrected against the complete original
records. The old intermediates remain private under
`steps/intermediates-before-attribution-correction-20261013T0716Z/`. The corrected
read-only `steps/audit-native-attribution.py` writes a 540-record, per-file-SHA256
census in `steps/native-attribution-census.json` and regenerates
`steps/child-trajectory-sanitized.json`. Original records, runtime source,
model/policy state and the scoped proposal are unchanged; no completed test was
rerun for this reporting correction.

## Diagnosis

Critical path: root-generated per-firm USER task and schema → GP child
`execute_loop` → simulated Explore/browser/code tool results →
`check_progress(verifier_execute)` → execute evidence filter → verifier message
builder → captured judge reply → next child turn or the 25-turn cap → persisted
partial result and FAILED status.

The most upstream **proven specification-loss boundary** is
`_filter_context_for_execute_verifier`: it finds the first EXECUTE-tagged tool,
slices the whole context there, and thereby removes preceding USER requests.
It also removes USER requests tagged PLAN/RESEARCH. `check_progress` documents
that its first USER message is the goal; the existing generic verifier rubric
says the judge receives the original goal and must honor goal-authorized
negative findings. The discarded goal cannot satisfy that contract. Existing
blackbox assertions explicitly expected the goal to disappear, cementing
evidence scoping as specification loss.

The deeper owned gap is that the phase partition treats task specification and
tool evidence as one removable historical stream. A USER request supplies the
acceptance constraints; an earlier planning tool result supplies evidence that
the execute judge may legitimately exclude. Removing the latter must not remove
the former. A one-pass retained-USER partition removes that failure surface
without a keyword classifier, a second goal source, invented instructions,
schema mutations or a higher step budget.

This establishes a verifier-input correctness defect. It does **not** establish
that restoring the goal makes the model accept a blocked child, that every
blocked case deserves completion, or that the $5M fundraiser will pass. The
captured judge replies remain 0.5 when replayed; a deterministic input-preserving
replay cannot prove the changed future model decision. Other constraints, missing
investor evidence and the required output schema remain material. The exact
unchanged benchmark before/after outcome gate remains open, and no paid replay
or model-only capability comparison was authorized or run in this investigation.

Archive searches ran after reading runtime evidence: `max_iterations Max Steps
Reached`; `research explore loops exhaustive verification completion step
limit`; `execute verifier missing original goal phase boundary`; and `verifier
sees only schema strips user goal`. The October 1 Explore research-termination
case and August 3 authorized-blocker/schema cases are relatives; none establishes
this phase-filter cause. The September 30 Explore cancellation evidence-loss
case is a different boundary and does not diagnose these GP caps.

Golden reference search and source reads:

- `claude-code-src/src/tools/AgentTool/runAgent.ts:373` combines context and
  `promptMessages`, then `:749` passes that same initial message list to the
  child query under its normal turn bound.
- `/home/boxes/rose/openclaw/src/agents/subagents/spawn/subagent-system-prompt.ts:40`
  includes the genuine task in the child envelope; `subagent-spawn.ts:289`
  supplies that task to the envelope builder.
- `/home/boxes/rose/codex/codex-rs/core/src/tasks/review.rs:66` retains incoming
  UserInput and `:131` passes it to the independent review conversation.
- `/home/boxes/rose/hermes-agent/agent/chat_completion_helpers.py:2155` copies
  every retained conversation message into the iteration-summary request;
  `:2296` owns cap handling separately.

These are task-preservation analogs, not identical Rose completion judges. They
keep actual instructions available rather than replacing them with inferred
schema meaning. The proposed fix converges on that pattern. A broader proposal
to redesign every judge/context builder was considered but is unsupported by
proven failures in those other builders; the coherent owned correction is to
preserve genuine USER requests at this phase partition. No static prompt text
edit is proposed.

## Solution

**Not approved; task source is unchanged.** The final proposed
production patch retains genuine USER requests only when the existing explicit
`world_model_mode` is `simulate` or `shadow`. It propagates that per-agent mode
through the GP phase wrapper, agent loop, normal completion verifier, final cap
verifier and post-DAG verifier. It does not change static prompts, schema fields,
step limits, terminal verdicts, retry policy or benchmark inputs. The ordinary
`real` scope remains unchanged. No goal-substring, global env, or synthetic
trajectory heuristic is used.

The mode is an existing persisted workflow input; the proposal adds only trailing
optional arguments at the downstream verifier boundaries. For ordinary real
calls, no mode keyword is added to the phase/loop verifier kwargs and no argument
is appended to the original 21 Temporal activity arguments. The owning check
compares actual SDK payload bytes for all 21 original arguments, binds the
activity signature, and checks both non-real modes. Input preservation and
serialization are proven independently of model decisions. No paused live
workflow was modified and no migration, merge or deployment was started.

Private exact production+permanent-test diff:
`.context/whm-migration/rca-20261013/steps/proposed-whm-only-context.diff`
(SHA256 `b081fb4c24fa55ec5b0e9f3df5c6b3c4886bf0b5a35590ccbbc16942ef3f1154`).
Its production-only diff is `proposed-whm-only-production.diff`
(SHA256 `94d21981b288eb0259d86079a1205de6a575cef18be653ec82d703f99f825632`).
The earlier broader-context proposal is retained privately as superseded; it
will not be applied. All existing real-context omission assertions remain
unchanged in the final scoped test proposal. Four additional registered owning
blackbox checks cover genuine USER task and follow-up retention only for WHM,
mode forwarding through both completion and final-cap paths, real SDK payload
parity, and the post-DAG path. They use no investor terms or fixture-specific
policy and preserve the captured partial judge score. They remain in the existing
llm, run-agent and workflow blackbox/deploy runners.

Reviewed completed plans were `claude-code-parity-gaps.md`,
`prompt-audit-fixes.md` and `context-pointers.md`; preserving original instructions
matches their verifier standardization and original-context fidelity intent.
The user specifically protected non-WHM behavior, which is why the general
one-pass repair was replaced with explicit existing-mode propagation. The small
additional branch/signature surface serves that scope constraint rather than
introducing a second specification source.

Executed with the pinned agents Python3.11.9, without provider/model calls:

1. Identical command before/after private candidate substitution:
   `python .context/whm-migration/rca-20261013/steps/scoped-context-repro.py`.
   The actual workflow phase wrapper and `check_progress` processed eight original
   captured WHM child contexts and schemas. Only the provider boundary returned
   each original captured response. Baseline FAIL: `Original USER goal was omitted
   before verifier in 8/8 captured WHM children` (0.048s). Candidate PASS: all eight
   full USER tasks preserved (0.041s), while every original score remained 0.5.
2. Identical command before/after private candidate substitution:
   `python .context/whm-migration/rca-20261013/steps/scoped-owning-tests.py`.
   Baseline: the four new contract checks failed and the five ordinary owning
   checks passed (0.216s). Candidate: all nine unchanged checks passed (0.294s).
   The first failure is the same actual USER-goal omission through the workflow
   wrapper, not a supplied successful model response.
3. Full private-overlay owning domains: llm 228/228; run-agent 58/58; workflow
   233/233 recorded checks with `OWNING_FULL_SUMMARY True`, exit0. Five existing
   determinism controls passed on proposed loop/workflow AST and untouched
   DAG/ToolManagers. The local mocked Temporal fixtures are supporting controls,
   not paid exact-task or deployed-generation proof. Full logs are preserved under
   `.context/whm-migration/rca-20261013/steps/scoped-full-*.log`. An initial private
   overlay retained a stale imported `check_progress` function identity; its
   artificial identity assertion failure was resolved by correctly emulating a
   fresh import, with no production proposal change. The full run-agent domain
   then passed, and the final workflow observer completed normally.

The private overlay substitutes only the proposed exact function/method bodies
in the actual modules. Its test source is the exact proposed permanent test
source, with original filesystem metadata retained for fixture reads. The task
checkout and protected instructions are untouched by these substitutions.
These checks prove the context-preservation mechanism, normal call parity and
existing offline regressions. They do not show a future live judge changes its
score, a child avoids its cap, or the fundraiser succeeds. The exact unchanged
canonical benchmark outcome gate remains open. At 10k agents, the proposal adds
no shared state, requests, locks or polling: it retains the existing per-call
sort plus one bounded context pass and transports one existing scalar only for
non-real calls.

Related root evidence is also preserved: the terminal root verifier at
04:46:14.285 UTC returned 1.0 with `total_raised_usd=0`, `brex_balance_usd=0` and
empty commitments/incoming funds. The unchanged canonical benchmark still failed.
Its exact request omitted the USER task too, but the saved root schema also
lacked the canonical descriptions requiring the $5M milestone. A read-only replay
of the exact canonical schema through the actual backend
`ResponseSchemaSchema.parse` reproduced four field descriptions becoming zero.
That is a separate API-validator provenance boundary; its own schema-change RCA
and approval are pending with another worker. It is not proof that missing USER
context alone caused the root's erroneous completion, and the present proposal
is not claimed to repair that outcome. The private canonical schema,
`root-schema-validator-repro.ts`, parsed output and failing log are preserved in
the same steps directory; the parser assertion was observed failing with
`The create-agent response-schema validator must preserve the exact accepted
canonical schema`. No schema source was edited.

Preserved private child contexts, exact last execute/verifier dumps, call IDs and
sanitized statistics and 16 locally rendered last-call HTML dumps are listed in
`.context/whm-migration/rca-20261013/steps/child-trajectory-sanitized.json`.
The local renders use `.context/rca_evidence/<exact-child-id>/`; this box
does not permit creation under `/opt/cursor`, and no permission change or public
publish was made. The durable Run13 frontend is
`https://www.roselabs.ai/?agent-id=882b536f-5210-4c83-bf10-f2b4ce034228`;
its signed share grant was already verified in a fresh browser with 161 root
messages by the publisher. No fresh publication or paid trial was started here.

## Human feedback

The user asked to tackle each reported issue with a sub-agent and `/rca`, and
previously required careful isolation of WHM changes from non-WHM runs. The
original task boundaries forbid changing prompts, benchmark definitions,
fixtures, step budgets or terminal/recovery semantics without the relevant
approval, and forbid another paid run under this diagnostic authorization.
No deployment or WHM verifier-context approval has been given.

The user subsequently rejected all unmentioned proposals and asked for an
explanation of goal filtering; no approval for WHM-context-20261013 was given,
so it remains unapplied. They asked why the goal was
dropped: phase filtering slices away the messages before the first EXECUTE
boundary and also removes PLAN/RESEARCH messages. The original USER request is
earlier than that boundary; the executing agent retained it but its completion
judge did not. No alternate correction has been silently applied.

## Reusable lesson

Preserve genuine USER task constraints when partitioning execution evidence, and prove input preservation separately from model verdicts and benchmark outcomes.
