---
id: 2026-10-15-minted-signup-delegated-contact-authority-unresolved
date: 2026-10-15
title: Minted signup delegated historical contact and stopped before verification delivery
surface: agents
component: root-browser-auth-delegation
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Historical contact became a signup recommendation and delegated identity; site withheld verification before generation; deepest cause unproven
symptoms:
  - Historical contact recommended as primary signup email
  - Browser obeyed exact delegated identity
  - Signup verification code withheld before generation
  - Tree stalled awaiting authentication assistance
tags:
  - minted-signup
  - delegation
  - account-authority
  - unresolved-cause
sources:
  - commit b5475e5be1f98e48e709298c0afcd2ea2e550ce7
  - agent 4cbb2429-ce20-45ab-8e96-6c541f720eb7
  - task 40985ea3-7113-523d-af60-f7a574748106
  - fleet run 574dc22f-ad9b-4df1-818c-33b496d5841b
repro: retained native root and child dumps plus offline root reconstruction; no causal baseline-fail candidate-pass proof
status: open
---

## Problem

Approved b547 runauth-approved-1792101206 browser-auth-minted-signup terminated
native FAIL948.2s on root4cbb2429-ce20-45ab-8e96-6c541f720eb7, browser task
40985ea3-7113-523d-af60-f7a574748106, dump prefix111db7dff237, sitea78ef8c6cbcb.
The ORIGINAL USER asks to create an account at the supplied URL and return its
member number; no email/account restriction is specified. Root later selects and
explicitly delegates a personal address. Prior RUNNING snapshots are preserved.

Native card SHA2568f55c458f1fc14092530fd5cb9f5e7f5d9b5f0d08bea292db092378c73910020
records948.2s,$0.02,136920input/4658output: native accounting, not a verified invoice.
Controller125120/125452 binds root ACTIVE/silent519s,threshold510s,cost_idle519s,
56messages,one nonterminal leaf;125121 records controller-owned early-fail pause.
No RCA intervention, clock reset or native failure replacement occurred.

## Diagnosis

Retained chain: raw contact → explorer recommendation → root operative goal →
child obeying goal → site verification withholding. Root first asks an explorer
for preferred/primary signup email; that question is not a user preference.
All12unique retrieved result bodies (6valid/6schema-feedback),9distinct raw
message records were inspected. The address's underlying user-authored WhatsApp
record88c9fc54-0a26-44b4-b61c-9a6fd4eb4006,2026-05-30T18:25:53Z, contains only
that contact. A different participant replies later. A July16 user message
concerns another service account's rate limit. No retained raw record establishes
current-target-site or persistent-default signup authority. This is not a claim
about unseen history or invalidity of legitimate past preferences. No literal
contact values are archived.

Explorer describes PRIMARY/likely email offered in a signup context, beyond the
retained contact-only evidence. Root call1792104173842-ceb99a38edfe-execute_loop.json
makes an explicit browser directive. Child receives the goal byte-for-byte apart
from Current Goal wrapper, follows it, types a new password ref and submits.
Site creates an unverified pending account, then code_withheld before newCode/
site.codes/sendPrimitiveEmail because the recipient fails its delivery rule.
Provider send, inbox receipt/extraction and OTP admission are NOT exercised
FOR A NEW SITE-ISSUED VERIFICATION CODE; this does not assert that background
inbox readers were never invoked, and no transport health/failure follows. This differs from SMS unknown-account lookup.
Do not blame the child for obeying the delegated identity or force a fixture ID.

Root already sees spawn_agent schema guidance(utils/tool_schemas.py858-863):
browser gets separate auth inventory; verification messages are readable at the
agent identity or connected mailbox, other addresses write-only. Gmail integration
is visible, but realm auth_options, actual minted identifier and researched-address
→connected-mailbox mapping are not. Zero search matches do not prove an inbox is
absent. Generic capability guidance is present, not an omitted-label diagnosis.

Existing EXECUTE policy explicitly allows reasonable assumptions. A grounded
personal contact becoming a model-selected account choice does not alone prove
violation of the broad user request. Distinguish actual current/persistent user
mandate from recommendation and account choice. Failing every personal choice or
requiring minted would fabricate a hidden membership oracle. Provisional contract
problem_class is NOT a proven inconsistency/intelligence limitation; cause unknown.

Retained archive searches: `signup code_withheld personal email`; `delegation
account preference historical contact identity`. Real-user-context smoke and
misaligned delegated-goal cases are relatives, not proven same causes. Their
Solution/Human feedback and local Claude/Codex/OpenClaw/Hermes delegation references
were read. Those references retain parent-owned goal/context, not verified contact
preference or receipt mappings. No referenced repair imported.

## Solution

No repair selected/adopted. Exact ROOT offline reconstruction uses its own
buildSystemPrompt/build_llm_messages,seven captured messages,six native tools and
static/cache boundaries. Caller tool_choiceNone becomes wire required; caller
temperature1/max8192 are not emitted as such. Expected body SHA256 under explicit
gpt-6-sol deployment argument:
3c931a756bdab002bed2bf0d19cf26b36a31dd7e5370a27108f7d5af30008afc.
Historical wire/deployment,raw DB pointers/cache read-write state are missing.
Offline captured-pointer fixtures are not proof of backend absence. Three initial
pointer-resolution attempts were denied by guard,zero transmissions; final command
zero network attempts/model calls. NOT dispatch-ready: no unambiguous semantic
baseline-failure predicate under reasonable-assumptions policy was established.

Independent actual compiler evidence reproduces extra6k/head-tail/last-three
projection IN ROOT model input,not only UI:5999-character suffix from13178selected
characters;6939+278raw removed,two markers inserted. One of60ordered selections of3from5captured grep results matches; actual
callback completion order was not separately retained. Selected
personal email COMPLETE raw record remains,so truncation-caused signup is unproved.
Existing shared50k compaction cap has prior overflow proof; neither deleting all
bounds nor increasing6000 is justified. Compiler fidelity proof remains separate
from account-choice causality; no source/test/prompt edits followed.

Owning reproduction design targets explorer evidence→root authority/delegation,
not child goal copying or provider transport. Controls: current/persistent explicit
restriction,contact-only fact,third-party suggestion,other-site instruction and
unknown receipt association. A test already passing baseline (goal arrives intact,
withholding precedes generation) is supporting control,not repair evidence. Causal
same-assertion baseline-fail/candidate-pass and unchanged canonical outcome/cleanup
remain absent. No paid root replay or task retry was run under these packets.

Finite permitted authentication candidate exhaustion C1 and natural broader finite
alternative-action-set C+1 are both coherent designs,not established causes here.
Permission/applicability/must-try/stop conditions need authority; no hard gate from
AuthRuntimeState. No failed next-deeper coherence proved: Step5b INCOMPLETE,
no prompt/controller selected. Parent's separate SMS product clarification is
PENDING,not an approved signup identity rule. Negative SMS factor outcomes cannot
prove this distinct boundary. No model-intelligence/registration/provider claim.

## Human feedback

Parent authorized retained diagnosis,offline reconstruction and later metadata
preservation in a NEW exact-e976 isolated checkout only. No direct user approval
of a new account-selection rule,prompt or repair was inferred. Freedom,protected
instructions,original failures,active campaign and healthy peers remain untouched.
No push/adoption/deployment follows from this archive case.

## Reusable lesson

Keep original user authority, historical contact, model recommendation and delegated
constraints distinct while tracing the upstream decision, preserving provider
uncertainty before send, and retaining OPEN status until owning causal proof exists.

Private receipts: .context/auth-deploy/approved-signup-readonly/ and
.context/auth-deploy/approved-signup-root-offline/. Exact manifest/evidence hashes
are included in the metadata handoff; private contacts/history are not copied here.

### Retained cross-campaign comparator qualification

The earlier e576 and a6ae signup runs both began with a direct browser goal using an available verifiable identity, entered the minted email, received an actual OTP, and passed in 431.5s and 431.2s. The b547 run first explored preferred contact at the ROOT agent, then explicitly delegated the personal address; the browser obeyed that goal and the new site withheld verification before code generation, ending in a 948.2s failure. The earliest observed divergence is the ROOT first action, not a demonstrated browser delivery failure.

The initial ROOT system's three segments, tools, and configuration match exactly. All five initial messages match only after explicit URL/time/reference normalization; this is not identical historical wire input. Browser static instructions, auth section, tools, and configuration match, while dynamic goals, inventory, and history differ. Nine inspected source files covering client, GPT auth, Foundry, pools, browser-use, LLM helpers, prompts, tool schemas, and run-agent match across the three checkpoints; this is not whole-deployment equivalence or causal proof. The retained comparator README and structured comparison accompany the final deployment evidence. No model-intelligence, AUTH-STABILIZE-1 causation, or repair claim follows. The EXECUTE reasonable-assumption gap and product clarification remain unresolved; this case stays OPEN.
