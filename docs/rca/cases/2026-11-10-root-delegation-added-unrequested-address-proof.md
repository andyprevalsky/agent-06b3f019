---
id: 2026-11-10-root-delegation-added-unrequested-address-proof
date: 2026-11-10
title: Root delegation added an unconditional address-proof obligation to a generic purchase
surface: agents
component: root spawn_agent goal and required output selection
classification: unresolved
problem_class: other
first_bad_boundary: earliest observed obligation expansion is raw root model spawn_agent output; the deeper cause and mitigation effectiveness remain unproven
symptoms:
  - delivery_summary requirement remains unverifiable
  - required use of the supplied delivery address remains unverifiable
  - required shipping_destination remains unverifiable
  - Timeout after 1204s
  - PAUSED
tags:
  - browser-agent
  - delegation
  - purchase
  - completion-verifier
  - required-output
sources:
  - agent e774239e-a967-4ca6-b1bf-06e6bddcd1a5
  - benchmark run d8a675a0-c7e6-48c0-854b-250b5dc3ffc8
  - commit f61b9e9394b0e6cf0bd51f929d682c2ee57a5497
  - plan:.context/agentcard-e2e/stability-proof-20261109/round05-signup-trajectory-rca/receipt.json
  - agent deb778e9-b87b-47ef-8170-df3245fce861
  - benchmark run 1f077019-c81f-4d8f-b1a3-69a10c6205c7
  - commit ec6c24c530ddbb04e1e49672dbda809a8f7a5f18
  - plan:.context/agentcard-e2e/stability-proof-20261109/postfix05-session-expiry-rca/diagnosis.json
  - plan:.context/agentcard-e2e/stability-proof-20261109/postfix05-session-expiry-rca/before-results-manifest.json
  - plan:.context/agentcard-e2e/stability-proof-20261109/postfix05-session-expiry-rca/after-results-manifest.json
repro: none-recorded
status: open
---

## Problem

The unchanged `browser-auth-signup-purchase` case asked: "Buy me a Canvas Tote
from {auth_test_site_url}". In partial11 round05, root
`e774239e-a967-4ca6-b1bf-06e6bddcd1a5` delegated the purchase to browser task
`68b59ca8-937d-55b3-a1f7-c95762ff42e3`. The root's own required output had only
the product URL and order confirmation ID. Its raw model response added six
required child fields, including `delivery_summary`, and instructed the child
to use the supplied profile delivery address unconditionally.

The browser created the verified account, placed order `ORD-79829271`, and
reached the paid confirmation. The owning financial evidence recorded one
purchase/card/funding/provider transfer, zero unlinked transfers,
`CLEARED`/`CONSUMED` for 2123 sandbox cents, Stripe received2123/capturable0,
and zero remaining card balance. This is a used payment, not an unused-card
stall or a reason to reclaim funds.

Eight completion attempts scored0.5 because the supplied destination could
not be verified. The original task timeout was1200s; the driver observed
timeout1204s and native duration1220.5s. The canonical result is
`passed:false`, `benchmark_status:FAILED`, root `PAUSED`. Payment success does
not make this native task a pass.

Canonical evidence is
`agents/benchmarks/runs/20261110_025057_d8a675a0-c7e6-48c0-854b-250b5dc3ffc8_browser-auth-signup-purchase.json`.
The retained worker/backend/driver and recording locations are indexed in
`.context/agentcard-e2e/stability-proof-20261109/round05-failed-root-artifact-index.json`.
The operator published and verified the225-message failed trajectory and
correct-owner recording. Its durable viewer and entire-trajectory last dump
are retained in the private approval packet and publication manifest, rather
than copying expiring signed URLs into this source archive.

## Diagnosis

Raw root request `1c609225`, served by `gpt-6.1-sol-foundry`, already contains
the unconditional goal and all eight required child fields. Those arguments
match the persisted spawn call, background payload and browser start. Neither
the adapter nor the separate response-schema generator introduced them.

All eight captured verifier outputs ground the paid purchase but reject the
same destination obligation. Their actual input contains the delegated goal
and schema. The verifier does not independently invent the unconditional
address-use requirement. Billing ZIP and a shipping charge do not establish
the delivery destination. No verifier relaxation or field deletion is justified.

The merchant fixture exposes payment fields and Billing ZIP, but no delivery
address input or order destination record. The browser repeatedly inspected
the existing confirmation, account and checkout rather than buying again.
The original user request and native task contract do not require destination
proof. Earlier same-case passes in rounds02..04 used conditional profile
inputs or returned delivery details only when shown. These observations locate
the earliest semantic expansion; they do not prove an intrinsic source defect
or a controlled model-capability limitation.

The root continued waiting for its browser child and never attempted its own
completion. The first pause followed the driver timeout: backend POST pause
at02:50:18.346Z, worker pause signal at02:50:18.669Z and browser cancellation
at02:50:25.080Z. The pause is cleanup's consequence, not an earlier human
interruption or evidence of scheduler loss.

The narrower problem is model-selected extra delegation obligations. The
next deeper class considered was faithful decomposition of the original task.
A broad constraint-provenance validator, new handoff mechanism or fixture
shipping UI was not supported by this capture and was not implemented.
Existing static delegation guidance is the selected general mitigation
boundary. Its effect remains unproven; classification therefore stays
`unresolved`, rather than claiming a source-contract contradiction or model
intelligence limitation without the required controlled proof.

The related August3 generic provider-order-ID and authorized-blocker cases
changed schema-generation/normalization contracts. Here the additional
obligation was in raw root output, so those downstream repairs are not the
owning boundary.

### Recurrence after the first general mitigation

On unchanged `ec6c24c530ddbb04e1e49672dbda809a8f7a5f18`, four full eleven-case
postfix rounds passed. The fifth ended10PASS/1FAIL: the failed case was now
`browser-auth-session-expires-at-checkout`, root
`deb778e9-b87b-47ef-8170-df3245fce861`. Its original1200s timeout and1219.0s
duration produced native `FAILED`/`PAUSED`. The historical55 attempts remain
54PASS/1FAIL, not five qualified full rounds or new-source proof.

The merchant trail proves the expected authentication recovery completed:
password sign-in22:49:32Z, deliberate expired-session rejection22:51:13Z,
password sign-in22:51:41Z, and paid order `ORD-51318213` at22:52:12Z.
One2123-cent sandbox chain was `CLEARED`/`CONSUMED`, with one card, transfer
and Stripe intent, zero unlinked transfers, zero capturable funds and closed
card balance0. Authentication and payment therefore do not explain the
subsequent completion loop. The root's pause again followed driver timeout.

Raw root request `b7e5282d`, served through user GPT auth as
`gpt-6.1-sol-gpt`, added a required `shipping_destination` among nine child
fields although its parent schema required only product URL and order ID.
The goal asked for the destination shown in confirmation; it did not make
that observation conditional. All fields and the goal match persisted and
background inputs. Ten completed verifier requests scored0.5 on absent actual
destination evidence after independently grounding the paid order; an eleventh
was unfinished during cleanup. The canonical artifact is
`agents/benchmarks/runs/20261110_230851_1f077019-c81f-4d8f-b1a3-69a10c6205c7_browser-auth-session-expires-at-checkout.json`,
SHA256 `b2854ede61ceb45fc3fdd82c0b3b1d10cc3fcfeefae124e127c474dee35c3b67`.

The first mitigation was present in all five actual root tool descriptions,
with identical description SHA256
`e232cf37bae091cca8098e8177c2c6eba607fdc6aced9b8a12a7afdfe3601e12`.
Native offline Codex projection retains the full goal description and schema;
historical outgoing wire bytes were not captured. Missing deployment or
projection is not supported. The prior four same-case passes recovered the
same expiry and used optional/conditional supplementary details. They used
Foundry while this failure used direct GPT auth; that difference is recorded,
not a controlled attribution to model capability or provider routing.

The authorized bounded BEFORE diagnostic made five actual model POSTs through
current canonical same-user/source GPT auth: three exact captured-root inputs
and two labelled counterfactual controls. Two exact outputs added no explicit
mandatory actual-destination proof; one required `shipping_summary` was an
ambiguous extra obligation that could be satisfied by a shipping charge or
status. Independent review did not classify it as reproduction of the actual
destination-only deadlock. Both controls preserved explicit user-address and
wrong-destination correctness. This is a NONDECISIVE reproduction, not0/3 or
1/3 native failures, not semantic/native PASS, and not a model-capability proof.

All five responses used `gpt-6.1-sol-gpt` and HTTP200; recorded input including
cache58202 plus output1623 totals59825 tokens, dollar cost UNMETERED. No
returned tools were dispatched. Private lease release was verified and all94
original evidence files were unchanged. Current production credentialauthority,
private lease/thread/cache and unrecorded historical token/account state limit
fidelity. A preceding retired-localhost setup attempt made0 model POSTs and
had unverified release; its failed receipt remains intact. No after-model or
new native outcome was generated. The case remains OPEN without the owning
causal red/green and unchanged native after proof.

## Solution

The parent applied the reviewed general mitigation in
`agents/utils/tool_schemas.py`, extending `BROWSER_GOAL_PROFILE_NOTE`:
keep the child goal and required output fields limited to the requested
outcome and evidence needed to establish it, while preserving user
constraints and necessary correct execution. It changes static tool guidance,
not verifier acceptance, schema shape, terminal behavior or native criteria.

Exact patch SHA256 is
`c8513f401ac4d9d7e15746a42e289c44c05c9469736096c6a550afddcac73e1c`;
the resulting source SHA256 is
`e434304562a619d9d2577c281fedeaf3e9e36d09583338e6bf5b473fd0e43872`.
Independent reviewer `ph7afnee3j0dm6axgjd98jq3tn8htpgr` returned `GROUNDED`
for `signup-bounded-delegation-general-mitigation-v2`, packet SHA256
`6b43b8980b29e2a0ab41b87ad42f5a174c34ec391837319a3e605313cf9e5ee9`.
Directly inspected references include Hermes
`tools/delegate_tool.py:708-723` (self-contained goal/context and only required
fields the parent needs), Codex `multi_agents_spec.rs:747-752` (bounded concrete
needed output), Claude Code `AgentTool/prompt.ts:257-269` (clear expected work),
and OpenClaw `subagent-completion-instructions.ts:1-4` (original requested
outcome and in-scope blockers). Rose retains its strict evidence verifier.

The profile-specific alternate patch `e8577bde` remained `NOT_GROUNDED`, was
never applied, and was not presented as a user approval request.

Offline request reconstruction matched all11 captured tools exactly before
the change, and only the reviewed description differed afterward. The planned
private diagnostic allocation was three exact-root samples plus two labelled
semantic controls per variant. Its first before attempt stopped before any
model send: the current native client selected an OpenAI API-key route,
whereas the captured call used Foundry. The endpoint guard refused the changed
route. Actual model POSTs were0 before and0 after, completed exact/control
samples were0, and no model before/after result exists. Original root/child
dumps and canonical result passed the byte-identity audit. No keys, cooldowns
or routes were changed to force a replay; the parent stopped further model-only
work. This replay fidelity gap is separate from the native failure's cause.

The existing `llm` and `tool-schemas` registered blackbox suites own projection,
original-goal custody and boundary checks; parent-reported passes do not prove
the model's delegation choice. The unchanged native
`browser-auth-signup-purchase` case is the existing behavioral regression.
No new paid CI, description-string test, prompt nudge, retry or timeout change
was added. At initial filing, native after-run proof was pending. A subsequent
focused signup run and four full rounds passed before the recurrence above;
those outcomes do not establish that the general mitigation eliminated the
failure class. Original native results remain unchanged. This case remains OPEN.

The next proposal on `307e719d09d4290808b0322adb8eb3d8ca06f9ea` is one hunk
in the same shared note: supplementary observations stay conditional in
the delegated goal and optional in `output_schema`, while explicit/standing
user constraints and all necessary steps/evidence remain strict. Patch SHA256
is `87c295e35a00993efdceedea01a2c50df237c99f1e566dc31f83eaf8f2692da9`,
candidate source SHA256
`c1a71ccb05881cfec457cd2d06d9771cf07558bc54ee9e8e8e02ad32c3680dd1`.
It is an unproven general policy experiment, not a source-bug or fix claim.
The exact complete packet and snapshot are retained under
`.context/agentcard-e2e/stability-proof-20261109/postfix05-session-expiry-rca/proposal/`.
Fresh independent review grounded the unchanged hunk after correcting a
packet-only Claude citation overclaim. Reviewer
`ph7afnee3j0dm6axgjd98jq3tn8htpgr` acknowledged final packet SHA256
`684da46f96dd15ca0959a9c331b5d20d2190088fe90219a1a3250f22bee4641f`;
the prompt mechanism gate is clear, without efficacy or outcome certification.

The parent applied that exact hunk, yielding the candidate source hash above.
The existing public `llm` and `tool-schemas` blackbox domains passed2/2, with
268 LLM boundary checks; these mocked checks do not establish model choice.
The authorized AFTER diagnostic completed five actual direct-GPT requests:
three exact captured-root inputs and the same two labelled controls as BEFORE.
Full offline native request comparison allowed only the approved description
change and private cache identity; the six messages and both controls matched.

Independent reviewer `ph7afnee3j0dm6axgjd98jq3tn8htpgr` verified all13 artifact
hashes and read all five raw AFTER returns against the original request and
the same controls. In all three generic returns, supplementary delivery
details were optional or absent, while required purchase confirmation remained.
Both controls retained explicit profile-address correctness and correction of
the observed wrong destination before ordering. However, the wrong-destination
control also demanded matching destination evidence from the order confirmation,
although its input required correcting checkout before ordering rather than
confirmation-page address display. That extra source requirement could strand
a correct paid order when the confirmation omits the destination. This is a
remaining contract-overreach risk, not a reproduced failure or permission to
weaken address safety. The controls do not receive a blanket semantic PASS.
Five responses were HTTP200 on the recorded model route; input including
cache58362 plus output1608 totals59970 tokens,
with dollar cost UNMETERED. Across BEFORE/AFTER, ten model requests used119795
recorded tokens. Both private leases were released and94 original evidence
files remained unchanged. No returned tool was dispatched. No further model
calls or retries are authorized under those exhausted budgets.

These observations support investigating the mitigation's intended behavior;
they do not turn the nondecisive BEFORE sample into a causal failing test.
There is no decisive owning red/green, controlled capability comparison,
merchant/verifier outcome from the dry calls, or native after-run proof yet.
The original native failure stays authoritative and this RCA remains OPEN.

Step5b considered deleting extra model fields, unifying the contract guidance,
and adding a guard. Field deletion would mutate model-selected schemas and
could remove necessary constraints. A deterministic parent-field subset would
reject necessary subtask outputs; a new semantic runtime guard would require
another unproven decision boundary and extra model calls. The selected bounded
experiment keeps one existing policy source for goal and schema optionality.
Hermes's static output-schema guidance requires only fields the parent needs;
Codex narrows delegated asks to concrete needed output. Their actual static
mechanisms support the proposal, not a guarantee of compliance. No verifier
relaxation, classifier, forced completion or new runtime architecture is added.

The parent selected focused repeatability plus full regression as the next
validation plan: existing boundary checks, at most five separately authorized
AFTER diagnostics (three exact inputs/two labelled controls), five consecutive
passes of the exact unchanged failed native case, then one complete eleven-case
final-source regression sweep, normal deploy gates and separate production
proof. The prior55-run depth was assistant-selected planning, not an explicit
user count requirement; choosing this plan does not change catalog criteria,
timeouts or concurrency or create a new human approval gate. It must be
reported as focused repeatability plus full regression, never55 passes or five
full-round qualification. Old54PASS/1FAIL gives no pass credit to changed
behavior. Application, after calls and native launches remain parent-owned.
Application and the bounded dry AFTER calls are now recorded above; native
launches and their financial, recording and cleanup qualification remain pending.


### Native focused validation, November 11

Five consecutive invocations of the unchanged
`browser-auth-session-expires-at-checkout` task actually PASSED/COMPLETED on
`d4b3f2fede0a45be1b25c4887f708bb7aacd016d`, with durations271.6,256.2,387.4,276.0
and266.4seconds. Original1200second limits, evaluators and task criteria remained
unchanged. Each original recording, exact sandbox paid card/transfer/PI chain,
automatic every-persisted-PI custody join and token-bound cleanup was verified.
All five databases, listeners and35 exact runtime owners retired. No operator
Stripe GET substituted for the new automatic custody proof.

Latest original recording: [verified native run](https://www.roselabs.ai/?agent-id=23ef9284-a5be-45c5-9319-006bab026b04#benchmark-share=b853da9d-ec26-43e4-aa49-cfa303a1b441.1796949561.131f4b0428e3977e33335ce1a1c19359fa7f72573ed7264c22ab837c323a190d).
The five sealed final packets and parent hash/grade/custody audits are indexed
by `.context/agentcard-e2e/session-expiry-repair-20261110/focused-five-final-summary.json`
(SHA256fb2614ed9b73c695c238d34b1d602de49a09cd3097a629e6eb220b39caa3eb1c).
This is five focused native passes, not five complete eleven-case rounds,
production proof or a controlled causal model comparison. A complete final-source
eleven-case regression and normal deployment/production verification remain
pending. The historical54PASS/1FAIL remains unchanged; the ambiguous dry control
and semantic generalization limits above are not erased by these observations.

## Human feedback

Preserve the real failure, all eight rejections and the successful paid order.
Do not fabricate address evidence, loosen required user/site constraints,
weaken native assertions, add shipping UI to satisfy an invented subgoal,
raise timeouts or inject trajectory nudges. Explicit requested addresses,
wrong merchant destinations and necessary execution checks remain strict.
The parent alone owns commits, native launches, cleanup and deployment.

## Reusable lesson

Keep delegated obligations tied to the requested outcome and necessary
correctness evidence. A reviewed general prompt mitigation still needs native
outcome proof; successful payment and downstream verifier consistency are
different facts from task completion.
