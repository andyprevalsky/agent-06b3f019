---
id: 2026-10-06-wmh-contact-lookups-lack-target-resource-grounding
date: 2026-10-06
title: WMH simulation policy and accumulated context suppress plausible public forms
surface: harness
component: serve-world-model prediction and archive retrieval
classification: unresolved
problem_class: uncaptured-user-preference
first_bad_boundary: WMH public-world generation lacks the user-specified policy for plausible unseen affordances; controlled policy/context effects reproduced, production repair remains unproven
symptoms:
  - I could not verify an official founder pitch-submission form
  - No verified Founders Fund investment-contact route was found
  - Submission route not verified
  - Timeout after 1801s
tags:
  - wmh
  - retrieval
  - resource-grounding
  - fundraising
sources:
  - agent 67885bdc-fd0f-4023-aa65-d3687df7f2ec
  - fleet run 22da47fc-6ac7-4ab2-8cb7-ac2a3ca57b5f
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
repro: none-recorded
status: open
---

## Problem

The user's Founders Fund screenshot exactly matches live WMH history entry
214 in session `60b1d1ac8627466c8e98fc977bec36d0`. It is a completed,
non-error explore prediction, not a crashed explore agent. The captured
session contains 279 transitions: 188 explore, 79 browser, 7 code, and 5
message boundaries. Earlier entry 13 reports no verified Precursor submission
route. Independently fetching https://precursorvc.com/startup.html returns
HTTP 200 and an actual founder application. Its 29,995-byte page has SHA256
`09478d52193fc1ab25055ae3e3d8c867d543f9b94ffdfe64bb311ee61b914a72`.
The original 30-minute diagnostic failed at the unchanged 1800-second override
(`Timeout after 1801s`), with no proven $5 million Brex receipt.

## Diagnosis

### What the trace establishes

Whole explore/browser/code calls are deliberately simulated. Their underlying
search/browser/CLI work does not execute. The WMH LLM receives the root task,
static environment state, recorded session history, five native retrieved
examples, and the action. It receives no source-discovery tools. Consequently,
phrases such as 'Sources reviewed' and 'URLs Visited' in these predictions do
not establish that a site was fetched.

Initial state supplies identities, connectivity and zero opening fundraising
funds; it contains no target investor website records, company product,
traction, legal entity, or deal materials. The first company-brief prediction
reports these facts unverified, and the first prospect-list prediction reports
most routes unverified. Later negative state notes are appended to a shared
scratchpad and included in subsequent requests. Retrying through browser or
code agents still makes another prediction; entries 216/227 even omit the
requested raw HTTP status and HTML output while saying SUCCESS.

Screenshot retrieval event 247 has four successful unrelated examples
(Manifest Investment Partners, Doug Given, a VC-role audit, Alchemy Springs)
and one cancelled Tokyo population search. Phone event 253 has five non-error
examples, three containing actual phone answers. Thus 'the samples are all
failed explore runs' is contradicted by the actual retrieval evidence.
An all-fields scan of all 179,449 rows in the original loaded native index
finds no Precursor or Hustle records, and only an unrelated Founders Fund
investment mention plus the ordinary phrase 'founders fundraise'. There is
no target contact/application resource in those matches. This is a concrete
coverage gap, not proof the entire corpus is corrupt. The corrected artifact
has 179,169 rows. The policy/model controls below reuse the original captured
demonstrations; they do not test a changed corpus artifact. Literal `DEMO FIXTURE ONLY` appears in one separately retrieved
archive-labelled task (event 264); its export eligibility still needs an
independent audit before claiming every corpus trajectory is clean.

### Executed controlled replays

Private scripts reconstruct native prompt assembly and call the original
`RoseWMHProvider`/Rose client, pool `rose-1-ultra`, GPT OAuth path,
`gpt-6-sol-gpt`, 16,384 max output tokens, and original system/default reasoning
configuration. No source-discovery tools or response schema are added. Rose
response-cache reads/writes are disabled; provider prefix caching remains
active. The original local benchmark backend had retired, so replay obtains
compute leases from production instead; model input and GPT provider path are
preserved and nonmatching fallback executions are rejected.

- Exact screenshot request: before-state, 211-step history prefix and five
  original native demos reconstruct 2,852,329 user characters. One valid
  replay reproduces the Founders Fund no-verified-route result (570,073 total
  input tokens). This proves reproducibility, not whether that firm's actual
  public route exists.
- Original Precursor request: 3/3 valid trials report no verified route.
- Remove only prospect-list history entry: 3/3 remain negative.
- Remove only the retrieved error example: 2/2 valid trials remain negative;
  one independent SSL bad-record-MAC transport failure is excluded.
- Remove history, or history plus scratchpad: no trial establishes the correct
  verified application URL. One changed result guesses `/contact/`.
- Change only the lookup goal, keeping original state/history/demos: 2/3
  guess `/pitch-us/`, 1/3 stays negative. None establishes the real form.
- Add only the independently fetched first-party page to current structured
  state's `public_resources`: **3/3 return `/startup.html` and accurate form
  fields**, with the original goal, history, demos, system, config and model
  unchanged. They correctly distinguish the existing application from the
  unknown Rose details required to complete it. Independent adversarial review
  verified exact equality of every non-resource prompt section and request
  configuration across this comparison.

The final control establishes that target website data is sufficient to
correct this specific false negative at the prediction boundary. It does not
prove that archive expansion alone is the remedy, that every firm's negative
is false, or that a model upgrade would fix it. No model-intelligence
classification is established. Shared negative history is observable, but
removing it did not isolate the cause; do not claim the prospect list is the
sole causal anchor. Earlier waterfall-route and multi-variable lookup-only
experiments are excluded from causal proof; the latter also overwrote its
per-trial captures and produced an unverified URL.

Hustle is a distinct example: entries 23/85/274 do recognize its pitch route
but decline to submit without verified company/product information. Contact
existence and ability to fill an application are separate missing-data issues.

Archive searches used `Claude Code Spinning up Code agent complete` and
`WMH no verified contact submission route absent`. The prior root-goal/seed
case is a relative, not proof of this cause: the current trace contains the
root goal and connected-service defaults.

### User clarification and simulation-policy/model controls

The user clarified that exact real-site contact fidelity is not the intended
criterion: WMH should instantiate plausible forms in its simulated world.
Unknown Rose product/company facts are acceptable application blockers. The
prior first-party-page control demonstrated resource sensitivity, but it did
not establish that fetching real pages was necessary for this simulation.
The user asked to isolate missing predictive context, the system prompt, and
GPT-6.1 Sol, and to include the actual browser-agent goal.

The full root goal and specialized browser goal were already present in the
original request. The exact Precursor browser action is history 97; Founders
Fund is history 88. Both allow a truthful private introductory inquiry and
prohibit invented company facts. The complete goals and all diagnostic
system additions are preserved in
`docs/plans/active/wmh-evidence-20261006/browser-goals-and-simulation-policy.md`.
Precursor's goal suggests `tamarachayo@gmail.com`, while fixed state identifies
`tamara@roselabs.ai`; every control preserves that same goal and state. Positive
simulations use the state identity. The email suggestion was held fixed in
every comparison; those positive results show it does not categorically
prevent a submission. Its independent causal effect was not isolated.

Model-only controls use an in-memory PoolSpec replacement, changing only
`gpt_auth_model` to `gpt-6.1-sol`. Original system/user messages and collected
arguments are byte-identical across models. Responses confirm the expected
actual models and the same GPT OAuth path. Both use default xhigh reasoning,
16,384 provider max tokens, no added tools, and disabled Rose response cache.

Completed browser trials:

| Control | Precursor | Founders Fund |
| --- | --- | --- |
| Original GPT-6 Sol, recorded context | 0/3 routes | 0/3 routes |
| Original GPT-6.1 Sol, recorded context | 0/3 routes | 0/3 routes |
| Sol plus open-world policy, recorded context | 1/3 routes and inquiry submissions | 0/3 routes |
| Sol plus open-world policy, history and notes removed | 3/3 routes; 1 inquiry submitted, 2 valid unknown-company-data blockers | 3/3 inquiries submitted |
| Original Sol, history and notes removed | 1 concrete route, 1 nonspecific intake, 1 no route; 0 submissions | 0/3 routes |
| Original GPT-6.1 Sol, history and notes removed | Not run | 0/3 routes |

The Founders comparison is a two-by-two policy/context control: changing only
the policy fails with recorded context; removing only history/notes fails
with the original policy; their combination produces 3/3 plausible form
submissions. Under the fixed open-world policy, only the compound history and
scratchpad intervention changes between the failing and positive Founders
arms. Task, retrieved examples, structured state and complete action remain
identical. These generated inquiries do not invent Rose product, traction,
terms, investor commitments or funds; funding remains $0.

The early Precursor explore request further separates the policy from model
capacity: original Sol 0/3 forms, boundary-only context clarification 0/3,
removing only the grounding paragraph 0/3, and append-only open-world policy
3/3 forms with fields. GPT-6.1 Sol with the original prompt returns one
concrete form with fields and two partial intake descriptions. Therefore the
original model can synthesize useful environmental details; a model upgrade
alone does not resolve the recorded browser cases. The boundary clarification
also leaves all three recorded Precursor browser requests negative.

The original prompt emphasizes a real system, concrete values grounded in
state/history, and filling unknown fields when a target already exists. It
lacks a clear contract for instantiating previously unobserved public page
contents and distinguishing unverified from nonexistent. The diagnostic
open-world addition supplies that policy while preserving explicit facts and
real action failures. The controls prove sensitivity to this policy and to
accumulated context; they do not isolate a single literal system line,
individual earlier observation, history separately from scratchpad, or a
universally correct production prompt. Replays excluding a failed preparatory
`role_only` edit are recorded honestly; that accidental unchanged-input batch
is not counted as a policy intervention.

Browser retrieval event 105 includes two completed checkout flows, one paused
Uber task, a FCaptcha form, and a submitted Shadow DOM form. This also rejects
the theory that the browser demonstrations are universally unsuccessful.
Independent adversarial review verified the controlled inputs and corrected
partial-result counts before handoff.

The portable receipt
`docs/plans/active/wmh-evidence-20261006/synthetic-form-policy-diagnosis.json`
contains 57 valid trial records, input/output hashes, model identities,
synthetic route/action summaries and explicit limitations. No production
prompt or model was changed, and no new full benchmark was run. The next
repair must define the general simulation contract for unseen environment
facts and epistemic history; it must not force every lookup or fundraiser to
succeed. This open case records controlled findings, not production or
fundraiser recovery.

### Follow-up: delete only the omission sentence

The user questioned and then explicitly requested removal of
“Facts omitted from the state are unobserved, not absent.” from the diagnostic
policy. The sentence and following separator space were deleted, preserving
the rest of the successful Founders Fund request with history/current notes
already removed. Three new calls through the same client path produced **2/3
simulated form submissions with on-page acknowledgments**, and one no-route
result. All used `gpt-6-sol-gpt`; all retained $0 funding. The earlier arm with
the sentence returned 3/3 submissions. The sentence is not necessary for a
submission in this setup; three trials per arm do not establish a statistically
reliable rate difference. No broader benchmark or production repair is proven.

Exact command from this worktree, with the existing activated `agents/venv`:

```bash
WMH_REPLAY_OUT=wmh-without-omission-sentence WMH_REPLAY_LABELS=browser-founders WMH_REPLAY_VARIANTS=open_world_no_history_or_notes WMH_REPLAY_TRIALS=3 python3 .context/wmh-without-omission-sentence-replay.py
```

The calls completed in 29.829, 32.813, and 35.528 seconds, without execution
errors. Script assertions and independent adversarial review confirm each full
user input is unchanged and the collected request differs only by the sentence
deletion. The portable `omission-sentence-ablation.json` in the plan evidence
directory contains exact extracted outputs, model identities, and prompt,
request, and response hashes. The current local prompt viewer displays the
sentence-removed candidate and retains immutable previous/original tabs.

Archive follow-up searches: `WMH unobserved not absent forms simulation policy`
and `Founders Fund no verified route context submissions`. This continues the
same open case; it is not a recurrence of a previously deployed fix.

### Follow-up: current upstream prompt and request framing

The user accepted that a no-route result can be legitimate, then asked whether
current upstream improves these predictions and whether its architecture
differs. Rose remains pinned to July 3 WMH 0.1.0; latest checked upstream is
Experiential 0.7.158 at `bf75987eac5e8c984d8f3868249f84e4095d1733`, with a
v3 text prompt last changed October 2. The original installed, artifact and
captured prompts exactly match the July pin. Corpus refresh preserves the
saved prompt, so the current integration has not followed those prompt updates.

Twenty-four new calls used original actual `gpt-6-sol-gpt` and fixed browser
goals, with three trials per firm in four arms: upstream instructions adapted
to the old response format; exact upstream system/native response protocol
with legacy evidence framing; that protocol with history/current notes removed;
and the actual upstream request builder with an explicit captured-data adapter.
Every arm returned 0/3 concrete routes and 0/3 submissions for each firm. Two
cleared Precursor predictions described a vague pitch application without a
destination or concrete fields and were blocked by accepted missing company
facts. No execution errors occurred; all results retained $0 funding.

The native builder adapter preserves task, goal, candidate, initial/current
state, history action/observation content and five source demos, but derives
incomplete tool schemas and labels demo prior state within initial context.
It does not recover native artifact provenance or demo episode starts. Actual
upstream parser and call-correlation validation passed for all 18 v3 replies.
No upstream retrieval, packing, admission or multi-turn state loop was run.
This is evidence of no demonstrated concrete-route improvement in the tested
calls, not proof a fully migrated upstream engine cannot generate forms.

Architectural changes include complete private JSON state, declared schemas,
parallel call/result correlation, full task-context grounding references,
immutable prompt/model/source identities and lineage exclusions. Rose already
blocks synthetic observations entering retrieval. Optional-example packing
does not compact required history. The new package/API/Python/runtime defaults
require a deliberate migration, rather than merely swapping the dependency pin.

Exact outputs, hashes, adaptations, source links and limits are preserved in
`docs/plans/active/wmh-evidence-20261006/upstream-prediction-comparison.{md,json}`.
Independent adversarial review verified transport controls and conversion
limits. Archive searches were `WMH upstream prompt state_note tool_results`
and `simulated no contact route Founders Fund`. This continues the existing
open diagnosis; no production repair or fundraiser recovery is claimed.

## Solution

### Native continuation and same-route policy control

The complete native migration and artifact rebuild did not resolve this
outcome. Native run `f5e4f83d-386a-4af1-84f5-7745216b6f27`, root
`29064cc2-3266-4605-8e63-eda79e48a0cc`, failed at the authorized diagnostic
limit with $0 raised. At the captured revision-42 snapshot, eight distinct
public-investor browser call IDs had 51 completed prediction responses with
no positive route or send. Those include stale/retried predictions; they are
not 51 terminal browser tasks or a final whole-run count. The exact native
Conviction browser prediction contains the full root/delegated goals,
state/history and five retrieved real examples; its user input is 210,974
characters, SHA256
`f8a575bb7f7da386de310516832d197a296cfca53c1f7a9ef4ea451cf03fa80d`.
The original upstream system is 1,716 characters, SHA256
`acae5f4de354cbd8e0e4753bbbf913a1100b8eeeb7af9ba84ed47f513d1b75ce`.

Three original and three append-only candidate calls all used the captured
`openai/gpt-6-sol` model on the same funded route, the actual Rose WMH
provider path and native parser. Removing only the added system paragraphs
makes their collected requests byte-equivalent. Originals produced 0/3
routes/submissions; candidates produced 3/3 plausible forms and one inquiry
each. All six retained existing company facts, approvals and zero funds,
with empty commitments, instruments and wires. The measured six-call span
was 104.787 seconds; completed-call metering was $0.423856.
Both arms deliberately bypassed credential leasing to hold the original
funded route constant. Earlier normal-pool trials routed every original to
OpenRouter and every candidate to GPT auth, so those six trials are
confounded and excluded from policy-only causal evidence.

This supports a policy effect for this specific captured native invocation;
it does not establish the fundraiser outcome or universal correctness.
The original v3 contract allows a legitimate no-route virtual page; these
controls do not prove a contradictory pair of runtime requirements or model
incapability. The general problem is an uncaptured simulation convention:
the user's expected treatment of unseen public affordances, scoped prior
observations, unknown private facts and completed effects was under-specified.
Six candidate-only negative controls subsequently passed: two explicit page
absences, two forms with required unknown legal facts, and two recorded HTTP
503 submission failures. All six reported no inquiry, preserved those scoped
constraints and existing private/funding state, and passed the native parser
on the original funded model. They change declared state/action constraints;
they are not original-input paired comparisons. The measured call span was
50.129 seconds and completed-call metering was $0.271156. The initial analyzer
mistakenly rejected a recorded form POST URL already supplied in observed
state; correcting that narrow allowed-evidence set made its audit pass without
changing outputs or making new calls. Both audits remain preserved.
See `docs/plans/active/wmh-evidence-20261006/native-form-policy-negative-review.json`.
The exact tested six-paragraph
candidate and outputs are in
`docs/plans/active/wmh-evidence-20261006/native-form-policy-controlled-review.json`.
The candidate remains unapplied. A versioned execution-policy proposal must
preserve the immutable upstream artifact identity and separately bind the
effective system text in health, predictions, cache and conformance before
approval or a new full benchmark.

The Step 5b class is the simulator's unencoded public/private generation and
scoped-observation convention. The next deeper attempt was a mechanical rule
that derives every unseen virtual environment fact from arbitrary task/tool
schemas and sparse JSON state. It is not coherent: sparse observations permit
several valid worlds, so middleware must still select a generation policy,
overwrite scoped observations or guarantee affordances/effects. Fetching more
real pages does not define novel virtual pages, and deleting prior failures
would discard legitimate observations. The current model already receives the
whole goal and can generate forms under the policy-only control. The proposed
general contract therefore belongs at the existing generation boundary,
without firm-specific routes, success guarantees or injected planner turns.
This is a bounded design argument for the current native architecture, not
proof that no future symbolic simulator or other non-prompt architecture
could solve the class.

No production prediction prompt, model selection, seed,
evaluator, or timeout was changed. Full evidence remains locally under
`.context/wmh-failing-*`, `.context/wmh-screenshot-replay/`, and
`.context/wmh-contact-{direct-replay-pinned,goal-only,first-party-control}/`;
a portable comparison receipt is in the plan evidence directory.

The next authorized repair should establish a general world-generation and
observation-consistency contract, then reproduce it in the permanent WMH suite
and matching inference conformance. Public world facts may be instantiated;
fixed user/company facts and prior effects must be preserved. The page-data control is
supporting causal evidence, not a hardcoded Precursor fix or a passing
fundraiser. General remediation and the exact unchanged fundraiser fail/pass
proof are still open. No production rollout has occurred.

## Human feedback

The user rejected the earlier speculative explanation and required reading
the actual WMH trace and underlying retrieved samples. They requested a real
diagnosis, authorized the separate code-card fix, and prohibited preemptive
prediction changes. Their supplied Founders Fund screenshot is not proof about its real website.
They explicitly clarified that real-world form fidelity is not required: the
simulator should generate plausible forms, while unknown Rose company facts
remain acceptable blockers. They asked for controlled system/context/model
comparisons and the exact browser-agent goal. They then questioned the broad
omission rule, requested the entire WMH prompt in a browser, and explicitly
asked to delete that one sentence and test the remaining diagnostic policy.
They then accepted that the no-route failure is technically fine and requested
comparison with the original upstream repository's current prompt and
architecture. Legitimate no-route and missing-company-data blockers remain
valid; improved submissions alone do not define simulator correctness.

## Reusable lesson

Define the simulator’s policy for unseen environment facts and preserve exact delegated goals when isolating prompt, accumulated-context, and model effects.

### Local implementation verification on October 7

The user explicitly authorized local prompt changes until deployment and held
deployment. The reviewed immutable public-affordances policy is applied locally.
Native31/provider59 owning checks, the registered WMH blackbox,24 backend cache
controls and102 benchmark retirement/cost controls pass. The first unchanged,
policy-bound100-case live suite was99successful plus one pre-header TLS failure;
its fidelity0.8518956/content0.589478 met aggregate floors, but the required
100-success gate failed. Exact current captures independently reproduced all99
scores and dimensions, validated all100 request hashes, excluded573 older
captures, and found no target transitions among retrieved demonstrations.
This open-loop suite had no declared protected private/financing fields, so it
provides no direct proof for unknown Rose facts; the six separate negative
controls retain that bounded evidence. Ten raw-tool cases retained zero demos.

The TLS failure escaped the waterfall's existing connect/read classifier;
raw SSL was already classified on the direct-auth path. A minimal classifier
addition made three identical actual-MockTransport owning failures pass and
kept partial output terminal. All213 registered offline Rose checks passed.
No model order, retry count, deadlines, output caps or network settings changed.
The external origin of the TLS alert remains unproved. All100 conformance
sessions then produced joined retirement receipts and both exact process owners
retired. The fresh policy-bound100-case run then passed:100 successful
predictions, mean fidelity0.8609352 and content accuracy0.5846759, independently
reproduced through the official parser/scorer. One protocol repair accounted
for101 attempts; all100 exact sessions joined and retired. Its unchanged
open-loop scoring limits still apply. The exact task was then run
with the authorized1800-second maximum as3730e4ca-2226-48bf-8434-78d56092b593.
It was interrupted after583.5 seconds because the committed revision3
pipeline output fabricated private prior introductions, conversations, message
IDs and conditional investor interest. Those facts were absent from the full
66,981-character current user payload, state, earlier history and all five real
demonstrations. Its rebase behaved correctly; the final generated content was
the bad boundary. Stale initial predictions, including a purported Delaware
certificate, are separate from committed effects. No investor-form submission
occurred before interruption. Exact joined retirement froze revision6 with
process aggregate usage$0.73468/10 calls; all owned processes and DB resources
retired. This is a cancelled diagnostic, not a full1800-second benchmark pass.

The six public-affordance paragraphs guarded unknown required fields on forms
but did not define the private-read/search case. A local v2 correction retains
those public rules and adds the missing distinction: do not fabricate private
prior history or unknown company facts; permit new replies/effects caused by
authorized new virtual actions. It remains a selection contract at the general
native generation boundary. A generic output parser can validate schemas and
receipts but cannot determine whether arbitrary natural-language private
citations are fabricated; deleting history would erase valid observations.
No firm-specific contact map or success oracle is introduced. Independent review of ten saved-request
controls found1/2 v1 private-history failures and0/2 v2 failures,2/2 submitted
virtual simple forms and2/2 valid unknown-required-field blockers. All10 used
the same actual OpenRouter gpt-6-sol model and passed the public native parser.
Both causally new reply cases returned legitimate no reply: positive future
response capability remains inconclusive. No threshold or response was forced.
Native32/provider66/backend24/Python-cache7/cloud-config-and-launch11 owning
checks pass;150 captured old cache keys remain byte-identical. Fresh matching
full conformance and the clean unchanged fundraiser remain required. The
portable receipt is `native-policy-v2-local-review.json` in the existing plan
evidence directory. No benchmark success or production
repair is claimed. The original failed report
is preserved in `native-policy-first-conformance-review.json` beside the
existing handoff evidence.
