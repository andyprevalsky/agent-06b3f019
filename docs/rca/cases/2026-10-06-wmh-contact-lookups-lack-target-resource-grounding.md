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

### Follow-up: fixed-prompt model-family probabilities on October 7

The user requested diagnosis and one fresh distribution from each model family,
with prompting fixed. Ten actual models were confirmed: Qwen 3.8 Max Prime,
DeepSeek V4 Pro 0813, Grok 4.7, GPT-6.1 Sol, Claude Opus 5.5, Gemini 3.8 Flash,
Kimi K3, GLM 5.3 Prime, MiniMax M3, and Mistral Large 4.0. Each received the
identical effective distribution system and complete captured Conviction user
input, including all 58 history messages, five original examples, and exact
root/delegated goals. System SHA256 is
`9bc7c6e255737d202741cc50334bf06bf8428180cf90ae8c1cf32361e86f86b2`;
user SHA256 remains `f8a575bb7f7da386de310516832d197a296cfca53c1f7a9ef4ea451cf03fa80d`.
Output budget stayed 16,384, wire reasoning effort xhigh, temperature/seed
omitted, response-cache reads/writes disabled, with four calls in parallel.
Only the model selection changed; the diagnostic process pinned each funded
OpenRouter model, disabled credential leasing/fallbacks, and did not edit
production pool configuration. Provider reasoning-effort mapping and default
sampling behavior can differ between families.

One generated response per family assigned completed-outreach mass as follows:

| Model family | Form submitted | Email sent | WMH transition accepted |
| --- | --- | --- | --- |
| Qwen | 0% | 0% | Yes |
| DeepSeek | 15% | 8% | Yes |
| Grok | 0% | 0% | Yes |
| OpenAI | 0% | 0% | Yes |
| Claude | 0% | 0% | No: missing patch parent |
| Gemini | 0% | 0% | Yes |
| Kimi | 10% | 25% | Yes |
| GLM | 20% | 0% | No: incorrect call identity |
| MiniMax | 10% | 0% | No: missing patch parent |
| Mistral | 17% | 12% | No: invalid patch array index |

All ten emitted parseable probability distributions summing to one. Rejected
transitions remain rejected; their stated numbers are not executable WMH
results. Qwen, DeepSeek and Grok initially failed before generating content;
unchanged failed-only repeats produced their sole generated samples. The first
attempts captured only a generic all-models-failed exception, so their external
failure cause remains an observability gap. They are not zero-probability
predictions. Thirteen provider attempts yielded ten generated responses.

The returned explanations expose a specific inference error in the zero-mass
cases. History 19 says a suitable route could not be verified **from the
material reviewed**; history 43 repeats that bounded result. The browser goal
explicitly requests a new live-site search and conditional send. The only
Conviction-specific structured research record concerns Tamara's bounded
private Gmail/iMessage/network search, not an exhaustive public-site absence.
The tested distribution mode appends only `DISTRIBUTION_TEXT` to the pinned
upstream system (`agents/benchmarks/wmh_execution_policy.py:111`). It does not
compose the separate `PUBLIC_AFFORDANCES_V2_TEXT` policy. Consequently the
previously tested clauses permitting new virtual public affordances, defining
virtual verification, and preserving the scope of prior negative observations
are missing from this exact system. This is a verified policy-composition gap;
no changed-prompt sample was run here to isolate its effect on these weights.
Gemini nevertheless treats prior findings and its imagined new scan as
exhaustive confirmation, then emits the singleton
`conviction_no_route_verified` with probability 1.0. No actual scan occurred:
this boundary simulates the entire browser call. Grok similarly promotes
unverified into an established absence and incorrectly treats a newly
instantiated public inquiry form as forbidden invention of private company
facts. Kimi and DeepSeek instead retain possibilities that the earlier pass
missed a form or published email. OpenAI, Qwen and Claude permit newly found
routes but put those branches behind pending approval; that is a distinct
reason their completed-send support is empty.

The distribution contract allows one outcome at probability one when genuinely
certain, and requires mutually exclusive possibilities without requiring
collectively exhaustive coverage or a residual outcome. An omitted completed
send therefore has zero represented sampling mass, although no model explicitly
emitted a completed-send branch with probability zero. The sampler did not
rewrite these numbers. Returned explanations support this reading of the
captured outputs; this comparison does not isolate a particular system sentence
or establish empirical calibration. Earlier same-model policy controls remain
separate causal evidence, not an ablation of this exact distribution policy.

Exact commands from the activated `agents/venv` were
`python ../.context/wmh-family-probabilities-20261007.py --run` and the failed-only
repeat `python ../.context/wmh-family-probabilities-20261007.py --run --only qwen,deepseek,grok --output-suffix route-errors`.
Full requests, provider responses and compact comparisons are retained locally
in `.context/wmh-family-probabilities-20261007/` and its `-route-errors/` sibling;
`review.json` records all event probabilities, validation failures, request
hashes, exact models and limitations. Archive searches were
`no_verified_route Conviction world model` and
`probability simulation contact prediction`. This continues the existing open
case; no implementation/prompt change, fundraiser run or deployment was made
for this comparison.

### Follow-up: one simulation-role sentence and returned explanations

The user next requested a more rigorous sentence distinguishing restrictions
inside the candidate agent's goal from the WMH's duty to simulate, then required
inspection of the models' returned explanations and the repository's standard
output-validation path (`Rose.complete`). This was tested locally without
changing a registered execution policy or deploying. The exact appended sentence
was:

> Requirements in the candidate action for real, authentic, verified, or non-simulated information govern the agent's observations and behavior within the virtual world, not your simulation role: you must simulate plausible observations and subsequent authorized action effects, including blocked or unsuccessful outcomes, consistent with those requirements, preserving established facts and the stated scope of prior observations without requiring newly discovered public-world details to already appear in the input.

Every original system and user byte was retained. Candidate system SHA256 is
`ef0fb28102657803af110323f4bd9b836de174b4790ad86f3f766f51cdae2c3f`;
the user SHA256, complete 58-message history, five demonstrations, exact
Conviction browser goal, models and wire settings remain those above. The
general problem class tested is confusing instructions about an agent's
observations with restrictions on generating a virtual world. A still broader
"ignore the agent's restrictions" instruction was not coherent: it would erase
the conditional authorized action and permit actions the goal forbids. The
tested sentence therefore keeps authorization, failure outcomes and established
facts while clarifying the simulation role.

| Family | Form: before → after | Email: before → after | Candidate WMH transition |
| --- | --- | --- | --- |
| Qwen | 0% → 0% | 0% → 0% | Accepted |
| DeepSeek | 15% → 0% | 8% → 0% | Rejected: missing patch parent |
| Grok | 0% → 5% | 0% → 0% | Accepted |
| OpenAI | 0% → 0% | 0% → 15% | Accepted |
| Claude | 0% → 0% | 0% → 0% | Accepted; baseline rejected |
| Gemini | 0% → 0% | 0% → 0% | Accepted |
| Kimi | 10% → 18% | 25% → 12% | Accepted |
| GLM | 20% → 20% | 0% → 20% | Rejected: wrong call identity; baseline rejected |
| MiniMax | 10% → 30% | 0% → 10% | Accepted; baseline rejected |
| Mistral | 17% → 25% | 12% → 15% | Accepted; baseline rejected |

These are represented probabilities in model-generated distributions, including
raw rejected proposals, not measured success rates. One complete distribution
per model is insufficient to estimate calibration or isolate any individual
clause in this bundled sentence. Initial DeepSeek and Claude attempts exhausted
the unchanged 16,384 output budget: respectively zero visible content and
incomplete JSON. Unchanged failed-only repeats produced their sole complete
distributions. All twelve attempts and their failures are retained. Actual models
matched all ten requested models, response-cache reads/writes stayed disabled,
there was no cross-model fallback or repair, and maximum measured overlapping
trial intervals remained four. The batch plus failed-only repeats took 439.913
seconds. Commands from activated `agents/venv`:

```bash
python ../.context/wmh-family-role-line-20261007.py --run
python ../.context/wmh-family-role-line-20261007.py --run --only deepseek,claude --output-suffix retry1
python ../.context/wmh-standard-output-validation-20261007.py
```

Inspection of the provider-returned explanations establishes several different
inference mistakes, rather than a universal refusal to simulate:

- Qwen recognizes simulation and acknowledges a small chance of finding a
  route, but promotes scoped prior research into an established absence. It
  then chooses a probability-one result, partly favoring simpler output
  construction. The role reminder does not prevent support collapse.
- DeepSeek considers a new form but incorrectly treats a newly generated form
  confirmation ID and website behavior as forbidden unknown private facts. It
  also says new public details should not be invented without evidence the site
  changed. The actual ban concerns unknown private company facts and
  **pre-existing** private records, not all new virtual observations or receipts.
- Grok explicitly uses the new role instruction and distinguishes a newly
  discovered public form from an invented private record. It permits an earlier
  pass to have missed a footer route and includes a completed-form branch, while
  preserving approval and CAPTCHA failures.
- Gemini narrates itself as the browser agent and treats its imagined scan as
  conclusive absence. It narrows the actual permitted firm route to a direct
  Sarah Guo email and imports unrelated Rose Labs write-lock problems.
- Claude relies on remembered Embed-program details and assumes that program is
  unsuitable for this inquiry. It generalizes prior pending approvals for other
  writes into an assertion that a Gmail send cannot finish in this session. It
  considers, then omits, a successful form branch and treats generating a new
  published address as risky fabrication. Program suitability is the model's
  assumption, not verified website evidence from this experiment.
- Kimi, MiniMax and Mistral retain possibilities of a missed public route.
  Kimi distinguishes unrelated pending approvals from this action. Mistral
  explicitly distinguishes private-history negatives from new public discovery.
  GLM also models completed approval, but its wrong call identity invalidates
  its transition independently of these estimates.
- OpenAI returned no explanatory reasoning text. Its new email-sent branch is
  observable; its internal reason for assigning 15% is not.

The live calls already traversed `RoseWMHProvider` → `RoseClient.collect` →
`RoseClient.complete`, with owning WMH validation before cache write and again
at the provider boundary. However, they did **not** pass `response_model`, so the
standard typed structured-output branch was not activated during generation.
That distinction is now explicit in the diagnostic evidence.

The unchanged captured outputs were additionally replayed offline through the
actual `RoseClient.collect`/`RoseClient.complete` with a strict Pydantic
`WMHDistributionResponse`, then through the same caller boundary as
`helpers.llm.call_llm`: `_content_from_structured_rose_response` followed by
`response_model.model_validate_json`. This made no provider calls and did not
repair or regenerate any output. The original-content `parse_distribution`
guard still checks sums, exact call identities and every patch against the
original state. All ten complete candidate distributions pass typed shape
validation; eight pass both typing and owning semantics. All ten complete
baseline distributions pass typing; six pass owning semantics. Empty or
truncated attempts fail typing and remain failed. Captures contain flattened
text, so offline replay cannot recertify the original stream's output-item
cardinality or retroactively claim schema-constrained generation.

Evidence lives in `.context/wmh-family-role-line-20261007/` and its `-retry1/`
sibling. `review.json` contains exact controls, all probabilities and failures;
`reasoning-review.json` contains high-level returned-explanation summaries and
the entire unchanged browser goal; `standard-output-validation-v2.json` records
every attempt's typed and semantic validation. The role sentence is a mixed
improvement, not a complete fix. The next focused test should distinguish new
virtual observations/action-created receipts from pre-existing private facts,
and preserve the subject and scope of prior negative observations or approvals,
without prescribing event labels or success probabilities. The benchmark RCA
remains open; no fundraiser run, source-policy edit or production deployment
occurred for this experiment.

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

On October 7 the user requested a grounded explanation of zero assigned
probabilities and one fixed-prompt sample across Qwen, DeepSeek, Grok, OpenAI,
Claude, Gemini and relevant additional families. This was a diagnostic
comparison, not permission to change prompting or deploy.

The user then authorized a local simulation-role sentence experiment and
insisted on inspecting the returned model explanations, rather than inferring
reasoning from probability labels alone. They also required the repository's
standard output validation with reference to `Rose.complete`. Local prompt
experiments remain authorized; deployment remains on hold.

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

### October 7 isolated short-line probability experiments

The user subsequently requested three cumulative additions, each at most 100
characters, with every generated endpoint probability displayed in chat. These
local diagnostic additions were:

1. `New virtual public routes and submission receipts are not pre-existing private facts.` (85 characters)
2. `Failed searches are bounded observations, not proof that no suitable public route exists.` (89 characters)
3. `Give each probability a brief rationale in its description; earlier holds are action-specific.` (94 characters)

All three retained the full original Conviction candidate goal and visible
history. The model generated its own possible events; display categories were
assigned afterwards and were never supplied as event labels. Prompts, wire
requests, original generated branches and validation evidence are preserved in
`.context/wmh-short-line-iterations-20261007/`. Response caching was disabled,
models were pinned, and no cross-model fallback or output repair was enabled.
The initial diagnostic harness added one unchanged repeat when no complete
distribution was returned. This exceeded the user's one-call-per-model
requirement. The corrected comparisons below exclude every retry. A complete
but invalid proposal was retained rather than redrawn.

The first diagnostic wrapper initially failed to register its imported
Pydantic validator module. The wrapper was corrected and complete saved
responses were revalidated without regenerating their probabilities. A second
wrapper issue incorrectly treated a complete fenced JSON proposal as absent;
presence detection was corrected while keeping the standard typed validator's
rejection of fenced output. Those original samples and source snapshots were
preserved. These are harness defects, not evidence that WMH forecasts passed
live validation.

The third addition produced seven complete distributions among the eight
requested families; five passed both typed and owning WMH validation.
DeepSeek and Claude returned probabilities but invalid patch parents. Gemini
continued to assign all represented mass to no route. OpenAI assigned 15% to
form submission and 33% to email sending; Grok assigned 8% and 0%; Kimi 12% and
20%; GLM 0% and 17%. These single samples do not establish calibration or a
causal effect of the additions. Returned public probability descriptions
continued to cite prior negative searches, unsuitable routes and earlier
approval holds. They did not establish that the private-record prohibition
was the sole remaining reason for zero submission mass.

At the user's direction MiniMax and Mistral were removed from subsequent
experiments, and Qwen was changed to `qwen/qwen3.8-27b`, the model listed by
Cerebras. Direct Cerebras credentials returned HTTP 402. The user clarified
that the model should be called through the existing funded provider, so the
effective Qwen comparison used pinned OpenRouter. It returned no visible
distribution before the 16,384-token output cap; the permitted unchanged repeat
failed before output with a TLS alert. This is N/A, not a zero-probability
forecast. The Qwen model change also prevents attributing a difference from
earlier Qwen Max samples solely to the new prompt line.

Five fresh matched input controls were then frozen under
`.context/wmh-input-verification-ablation-20261007/`: unchanged Conviction,
removal of all current candidate-goal authenticity/verification requirements,
an observed Precursor application-form control, one recorded successful
checkout example, and that same single example marked for formatting only.
All five share the same probability-description request. The first two differ
only in the candidate goal; historical observations remain present. The
Precursor arm changes firm, goal, start URL and supplied public page fields, so
it is a positive control rather than another goal-only ablation. Required
unknown company fields and the unapproved deck remain legitimate blockers.

Independent review found that the first one-example payload removed four
example rows but retained their four grounding contexts. The scheduler was
stopped, those original samples were preserved, and both example arms were
corrected to retain exactly the selected successful example and its matching
context. Existing unchanged arms were reused rather than resampled. The
effective plan and corrected source snapshot were frozen separately; new
calls assert exact runner hash, model IDs and message equality. No production
deployment or fundraiser acceptance result is claimed.

The superseded retry-selected grid analysis contains 40 model/condition cells
and 55 attempts, including 15 extra failed-output repeats. There were 35 complete forecast
distributions, 34 typed-valid outputs and 32 outputs valid at both the typed and
owning WMH boundaries. All 55 recorded requests passed an independent check of
the frozen message hashes, pinned models, xhigh effort, 16,384-token cap and
disabled response-cache reads/writes. Provider input-prefix caching remains
possible and is distinct from reusing an output. The three original contaminated
example-arm attempts are preserved separately and excluded from this grid.
These controls return to the original distribution baseline plus the shared
83-character rationale line; they do not include the three cumulative additions
above. Compare matched arms with each other, not directly with an earlier
iteration as if the system prompt were unchanged.

The goal-only verification ablation does not consistently eliminate rejection.
Grok still describes the current goal as forbidding guessed addresses after
that clause was removed; the retained earlier tool result at history index 43
contains that instruction. Gemini assigns 95% to no route and 5% to a browser
challenge, with no success branch. GLM permits a 22% new form-submission branch,
but model and condition effects cannot be calibrated from one forecast each.
The returned descriptions directly show bounded-search findings being promoted
into site-absence assumptions and old instructions or approvals carried across
actions. They do not prove a universal system-level prohibition of simulation.

Using first calls for the observed Precursor form, six models produce fully valid distributions.
Five assign zero mass to no route; Grok assigns 38% to no route while discounting
the page observation embedded in the candidate goal as unsupported by prior
state. This arm supplies a goal claim, not a new environment-state observation,
so a provenance effect remains to be isolated. Most remaining form blockers are
the legitimate missing approved deck and required company answers. Some success
branches assume placeholders pass validation, and Grok's successful branch
changes the stated required fields. A receipt by itself is not proof that the
forecast respected all supplied facts.

Every complete forecast in both corrected single-example arms assigns zero
mass to cancellation. Full-example Kimi and GLM had explicitly cited cancelled
demonstrations from other worlds to justify cancellation probabilities, despite
the system instruction against using them as this world's outcome frequencies.
Removing those demonstrations supports that contamination concern, but changes
count, domain mix and input length together. The formatting-only sentence does
not consistently fix contact rejection: first-call DeepSeek assigns 100% to no
route, while Gemini and Grok produce no first-call distribution. Qwen's 18%
submitted-form and 4% inferred-email
proposal came from a retry and is excluded from the corrected comparison.
OpenAI assigns 9% to a new official form and receipt. That exact
branch uses the supplied agent identity, company working name, email, website
and constrained message, invents no private company history or traction, and
passes both live validation boundaries. This demonstrates simulation capability
on the isolated action, not a consistently repaired probability estimator.

### October 7 minimal probability controls and full-input interpolation

The user requested a minimal working example followed by interpolation back
into the full WMH input. This continues the existing open case. Archive searches
for `WMH no verified contact route` and `world model submission probability
demonstrations` both returned this case; it is a recurrence, not a new case.

Two pinned families were used for the fast diagnostic: `openai/gpt-6.1-sol`
and `google/gemini-3.8-flash`. Every call used the existing Rose WMH provider,
streamed structured-output accumulator, strict caller Pydantic validator and
owning distribution/patch parser. The wire response model remained absent,
matching the captured WMH path. OpenRouter was pinned, xhigh effort and 16,384
output tokens were retained, temperature and seed were omitted, response-cache
reads/writes were disabled, and no output repair or cross-model fallback was
enabled. One unchanged retry was permitted only when no complete proposal
existed. Complete fenced proposals were retained as typed-invalid samples.

There were 19 conditions, 38 first calls and three incomplete-output retries.
The selected samples contain 36 complete proposals, of which 34 pass both
validation boundaries. Two fenced proposals fail typed validation; two other
conditions have no complete Gemini proposal after both attempts. These failures
are N/A, never zero-probability forecasts. The public probability descriptions,
all displayed endpoint masses and independently checked request provenance are
in `.context/wmh-minimal-interpolation-20261007/diagnostic-summary.json`.
The verifier checks every recorded wire model, forwarded message text, effort,
output budget and disabled response-cache policy. OpenRouter's system text
block/cache-control representation is normalized only for text comparison;
provider prefix caching is distinct from response reuse.

The known-world controls supply an explicitly synthetic official form, truthful
name/email/company/site/message values, approval for this exact inquiry, and a
deterministic healthy executor. They make no assertion that the real Conviction
website has that form. Both models assign 100% to submission. Changing only the
form to require an unavailable approved deck produces 100% blocked in both.
A third fixture chooses form-present versus no-route with an independent fair
coin at workflow start, after every historical observation. Both models preserve
50% submitted / 50% no route when the original system, strict browser goal, root
task, current state, 58 history messages and five examples are restored. Gemini
has a fenced minimal proposal and two truncated current-state attempts, but its
fully restored history/examples proposals pass both validators with 50/50.
These are constraint and mathematical sanity checks, not empirical calibration
of the real site's availability or an actual LLM browser executor.

A separate unknown-site sequence removes the entire synthetic fixture, the
coin, all prescribed probabilities and the execution guarantee. It retains
only truthful basic inquiry values. Models generate their own event sets.
Classification into display columns happens afterwards; no fixed event labels
were supplied. The following are represented probability masses, not explicit
model judgements that an omitted event is impossible. Each condition has one
forecast per family, so differences are exploratory and do not establish a
stable causal effect of an individual restored component.

| Restored input | Model | Form submitted | Form blocked | Email sent | Email held | No usable route | Email-only unused | Browser failure |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Minimal unknown site | OpenAI | 23% | 37% | 0% | 0% | 0% | 35% | 5% |
| Minimal unknown site | Gemini, typed-invalid fence | 10% | 15% | 0% | 0% | 75% | 0% | 0% |
| Original system | OpenAI | 28% | 42% | 0% | 0% | 24% | 0% | 6% |
| Original system | Gemini | 10% | 18% | 0% | 0% | 72% | 0% | 0% |
| Original browser goal | OpenAI | 32% | 27% | 0% | 0% | 34% | 0% | 7% |
| Original browser goal | Gemini | 15% | 5% | 0% | 0% | 80% | 0% | 0% |
| Original root task | OpenAI | 10% | 0% | 27% | 0% | 58% | 0% | 5% |
| Original root task | Gemini | 0% | 0% | 20% | 0% | 75% | 0% | 5% |
| Original current state | OpenAI | 12% | 8% | 25% | 0% | 55% | 0% | 0% |
| Original current state | Gemini | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| Original history | OpenAI | 0% | 0% | 5% | 35% | 60% | 0% | 0% |
| Original history | Gemini | 25% | 0% | 0% | 0% | 75% | 0% | 0% |
| Original examples/contexts | OpenAI | 14% | 6% | 0% | 26% | 54% | 0% | 0% |
| Original examples/contexts | Gemini | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Exact original, no added inquiry values | OpenAI | 0% | 0% | 8% | 24% | 68% | 0% | 0% |
| Exact original, no added inquiry values | Gemini | 0% | 0% | 0% | 0% | 100% | 0% | 0% |

Restoring the strict browser goal leaves positive form-submission mass in both
families. Restoring the root task introduces email as a successful alternative;
Gemini's missing form branch there is not rejection of all outreach. Restoring
current state yields Gemini's first all-negative proposal, but adding history
reintroduces a 25% form branch. This nonmonotonic sequence does not isolate one
instruction or state entry as the cause. The complete unknown-site sequence
also cannot establish the true numerical probability of any real-site outcome.

Two one-field ablations at the restored-current-state step retain the original
system, goal, root task and every other state field, with no history or demos.
Emptying `research_reviews` produces OpenAI 33% form submitted, 10% form blocked,
15% email held and 42% no route; Gemini remains at zero submission, with 90% no
usable route, 8% email held and 2% browser failure. Emptying `pending_approvals`
produces OpenAI 17% form submitted, 8% form blocked, 25% email sent and 50% no
route; Gemini remains at zero submission, with 94% no usable route and 6%
browser failure. Neither deletion is established as a repair. A separate clean
goal-only factorial ablation was prepared but not executed; it must not be
reported as evidence.

The original Gemini proposal divides its entire mass between three no-route
variants: JSON report (75%), additional navigation (15%) and Markdown report
(10%). Its public descriptions cite prior negative search findings and an a16z
inspection pattern. Other Gemini descriptions cite assumptions about the real
Conviction website and the requirement for a suitable investor pitch channel.
They do not demonstrate a categorical system-level prohibition of simulated
public discovery. A completed proposal with all negative branches also does
not tell us whether the model assessed every positive mechanism and assigned
zero, or never represented those mechanisms in its short event list.

The deepest verified owned contract gap is at
`agents/benchmarks/wmh_outcomes.py`: the prompt requests one to six plausible
events and a normalized probability sum, while the parser validates shape,
call identity and state patches. It has no invariant establishing semantic
coverage or separating world outcomes from presentation variants. Consequently
an omitted possible event receives zero sampling mass. This explains why the
displayed zero cannot be read as a separately elicited impossibility judgement;
it does not by itself prove why the LLM omitted that event.

The next architectural experiment should separate model-generated world
scenarios and their coverage from probability weighting and full observation
rendering. Preserve scoped observations and legitimate private-field blockers;
do not introduce a form-success floor or remove verification requirements on
the strength of this sequence. Numeric calibration requires a defined world
generation process or labeled held-out transitions and proper scoring. The
known coin fixture supplies the former only for that fixture. No empirical
calibration result, tested production repair or benchmark pass is claimed.

Abstraction climb: the suspected strict-wording ban is contradicted by the
positive controls; a specific state-field explanation remains unproven; the
owned event-coverage contract is a coherent broader target. The still broader
proposal to have a generic validator certify arbitrary unknown-world
probabilities is incoherent because the validator lacks the corresponding
ground truth. No further registered prompt or default was edited in this
diagnostic. Existing native upstream comparison artifacts are supporting
generation controls, not an upstream calibrated-distribution implementation.

The executed base runner source is preserved at
`.context/wmh-minimal-interpolation-20261007.source-before-lint.py`. A subsequent
dynamic-import-only lint correction changes no model payload; frozen plans
retain the executed source hash, and the summary records both hashes.
All local diagnostic runners pass Ruff and compile checks. The case remains
open; the unchanged fundraiser acceptance and production replay checks remain
outside this user-requested isolated diagnosis.

Follow-up inspection of the actual captured browser request confirms a narrower
executor-context gap. The candidate is explicitly
`rose.browser.spawn_browser_agent`, category/type `browser`, depth `quick`,
start URL `https://www.conviction.com/`, with delegated goal, root goal and
output schema. Its goal explicitly says to carry through the final send/submit
control and that the approval harness handles approval. However, the declared
tool description is only: "Simulate this Rose environment boundary using the
complete delegated arguments and goal; return its canonical observation."
The request does not include the browser agent's actual system prompt, inner
tool definitions, selected model or concrete execution budget. Thus WMH knows
which agent boundary it is simulating but lacks a faithful executor contract.
This is a verified input omission, not causal proof for the no-route results:
those returned explanations primarily assert absence or unsuitability of a
public intake channel rather than inability to fill fields or click Submit.
An isolated executor-contract addition with the website still unknown would
test this hypothesis without the deterministic form/approval fixture's world
changes. That addition has not been run and is not a demonstrated repair.

The user next required comparative probability justifications in `description`,
instead of event narratives. A single fresh original-input GPT-6.1-Sol call
changed only the system's description placeholder to "probability justification,
not an event description" and appended the 95-character sentence "Justify each
probability briefly from evidence and uncertainty, relative to the other
outcomes." The wire request retained xhigh effort and the original user payload,
58 history messages and five examples; response caching, repairs and fallback
remained disabled. The call finished in 119 seconds and passed both validators.
No registered prompt was changed and no retry was needed.

The returned distribution is 78% no verified route, 18% newly published email
held for approval and 4% email sent after approval. The public justification
for the largest branch cites two prior Conviction-specific negative route
reviews. The pending branch cites bounded search uncertainty and repeated
approval-required results; the send branch requires both discovery and a new
approval response. No form-submission branch is represented. This directly
records the model's stated comparative rationale, not empirically calibrated
weights or a demonstrated executor-capability failure. Exact public text is in
`.context/wmh-probability-rationale-20261007/public-probability-justifications.json`;
the frozen request, changed prompt and wire validation are retained beside it.

### October 7 parallel block-influence controls

The user asked to associate each injected context block with an upward or
downward shift in the no-viable-form forecast, using only GPT-6.1-Sol xhigh and
running the controls in parallel. Eleven independent child processes submitted
one condition each: a fresh unchanged control plus ten scoped context ablations.
All eleven complete proposals pass both validators, with no retries, repairs,
fallback or response-cache reuse. The original world payload and the comparative
probability-justification request remain fixed except for each declared block
delta. Independent offline verification restores every changed block to the
original and checks exact wire message text, model, effort and output budget.
The executed plan and public explanations are retained under
`.context/wmh-block-influence-20261007/`; the checked result is
`public-block-effects.json`.

The metric is represented mass for an explicit **no suitable form/contact
route found** result. It is not a calibrated posterior that no viable form
exists: email branches do not establish whether any form exists. The fresh full
control assigns 76% no suitable route and 24% email held for approval. The
earlier identical input returned 78% no route, 18% held and 4% email sent.
Directions below describe this singleton batch, not replicated causal effects.
Including a block's observed effect is defined as full-control no-route mass
minus the mass when that block is removed. Effects are conditional on all other
blocks remaining and are not additive.

| Block removed | No suitable route | Email held | Email sent | Browser failure | Observed effect of including block |
| --- | ---: | ---: | ---: | ---: | --- |
| None: fresh full control | 76% | 24% | 0% | 0% | Reference |
| Native system prefix | 65% | 25% | 10% | 0% | UP 11 percentage points |
| System private-fact prohibition only | 62% | 25% | 9% | 4% | UP 14 points |
| Root task instruction only | 66% | 22% | 7% | 5% | UP 10 points |
| Initial world context | 70% | 25% | 0% | 5% | UP 6 points |
| Current world-state content | 70% | 23% | 7% | 0% | UP 6 points |
| Visible history | 50% | 32% | 18% | 0% | UP 26 points |
| Examples and matching grounding contexts together | 76% | 18% | 0% | 6% | Unchanged |
| Example task/initial-state content only | 64% | 24% | 8% | 4% | UP 12 points |
| Declared tool schema/description | 72% | 20% | 8% | 0% | UP 4 points |
| Candidate goal's prior-negative-search premise only | 72% | 19% | 6% | 3% | UP 4 points |

The grounding-content-only condition retains all five resolvable context-ref
keys but blanks each example's task and initial context; it does not leave
dangling references. The bundle removal clears both examples and their contexts.
These are different conditional interventions, so the bundle's unchanged
no-route mass and the context-only shift do not establish separate additive
contributions. The root-instruction removal retains copies of the root goal in
other blocks. The current-state condition retains empty structural containers
and validates patches against that exact snapshot.

The native-system condition removes the native prefix while preserving the
distribution/patch contract and comparative rationale request. The complete
candidate action and output contract cannot be deleted while retaining a
comparable defined prediction; the candidate condition removes only its bounded
negative public-search premise. No direction is claimed for deleting the whole
candidate or required protocol.

Visible history has the largest observed influence on the explicit no-route
mass in this batch. Even without history, the delegated goal still reports a
prior unsuccessful route search and state still contains pending approvals;
the returned explanation cites both. No condition generates a form-submission
or missing-required-form-field branch. All represented successful or
approval-held alternatives are email actions, verified from complete predicted
observations and effects. These controls therefore measure route/approval
forecast sensitivity and do not repair or establish coverage of form outcomes.
No production/default changes or fundraiser acceptance result are claimed.

A fresh, isolated GPT-6.1-Sol xhigh adversarial reviewer confirmed the arithmetic,
the use of the contemporary 76% control, and the narrow metric interpretation.
It required explicit singleton/nonadditive wording and precise removal scopes,
including retained root-goal duplicates and the five grounding reference shells.
The review checked the supplied experimental report; exact source/wire checks
were performed separately by the offline verifier. All eleven invocation
intervals overlap from 23:52:50.769768 through 23:54:26.587730 UTC, independently
confirming the parallel launch. The existing open case remains a recurrence;
the same two archive searches again returned this case before these controls.

All full prompts, delegated goals, branches, endpoint grouping and public
probability descriptions remain in the local diagnostic artifacts. The final
wire verification is `experiment-verification.json` under the grid directory.
The case remains open; no source prompt, production default, real submission,
deployment or full fundraiser outcome was changed by this experiment.

The user's explicit correction was: each iteration is one call per model.
Both ignored diagnostic runners now disable failed-output retries. Every
comparison was rebuilt from its saved first attempt without any new model call.
The authoritative artifacts are now
`.context/wmh-first-call-only-20261007/`, including the three short-line
iterations and all five matched controls. The five controls use 40 first calls,
with 25 complete distributions, 25 typed-valid outputs and 24 outputs valid at
both boundaries. Failed first calls remain N/A, including cases where a retry
had previously produced a complete forecast. Earlier retry-selected charts and
claims are superseded; the 15 extra retry calls and three earlier faulty-context
attempts remain separately preserved and excluded. First-call OpenAI's 9%
formatting-only form branch remains valid and unchanged. This is still an
isolated simulation result, not a repaired fundraiser benchmark or deployment.


### October 7 candidate-tool approval assumption

The user specified that every action requiring approval should be approved
within simulated tool execution. A diagnostic appends exactly one 96-character
system line: "In this simulation, all approvals needed by the candidate tool
are granted during its execution." The original full user payload, comparative
probability rationale request, private-fact restrictions, examples and history
are byte-identical. No registered policy or runtime default was changed.

Two GPT-6.1-Sol xhigh calls ran concurrently, one per condition, with no retries.
The fresh full control returned 70% no suitable route, 25% email held, and 5%
email sent. The approval-assumption call returned 66% no suitable route, 28%
email sent, and 6% browser failure, with no approval-held outcome. Both pass
Rose's typed caller validation and the owning distribution/patch parser.
Offline verification confirms exact forwarded messages, actual model, xhigh,
16,384-token budget, disabled response cache, and overlapping call intervals.

The model's public justification for the 28% sent branch explicitly cites
"connected Gmail and granted execution approvals"; its remaining no-route
branch still cites repeated unsuccessful research. Neither condition generated
a form-submission or form-blocked branch. This singleton comparison supports
the approval conditioning semantics, not calibrated route probabilities or a
repaired fundraiser. Later generic evidence-scope and outcome-coverage edits
remain proposals. Full prompts, complete observations, and public rationales
are under `.context/wmh-approval-assumption-20261008/`; verified results are in
`public-approval-comparison.json`. The existing RCA remains open.


### October 7 public Explore probability diagnosis with approval-only policy

The user retained only the approval assumption and requested diagnosis of the
Explore probabilities underlying the earlier missing-form result. The exact
original public Conviction Explore payload was replayed with GPT-6.1-Sol xhigh,
the established diagnostic distribution/comparative-rationale contract, and the
96-character approval line. No scope-evidence or outcome-coverage policy rule
was added. The original older GPT-6-Sol single-transition result has no recorded
probabilities; the following are fresh diagnostic forecasts, not reconstructed
historical probabilities.

Two concurrent calls compared the original input against removal of its five
Andy-profile examples and matching contexts. Both pass the typed and owning
validators without retries. The original returned 55% published email and 45%
route unresolved; no examples returned 60% email and 40% unresolved. Neither
represented form discovery. The public justifications cite quick research depth
and an endpoint not established by the earlier homepage-only prospect result.
The complete observations explicitly scope unresolved findings rather than
asserting global form absence.

Those descriptions did not explain form-versus-email event selection. A third
call changed only the distribution schema's description placeholder from
"probability justification, not an event description" to "probability reasoning
comparing form and email discovery; explain any omitted channel". This asks for
public probability explanation and prescribes no branches or numeric weights.
The original goal, depth, world state, history, examples and execution-policy
lines remain byte-identical. It returns 50% email discovery, 30% form discovery
and 20% unresolved route, passing both validators. The form branch instantiates
an official-site-linked /contact page with name/email/company/website/description
fields and optional deck URL, inspected read-only with no submission.

The model explicitly calls a founder intake plausible, while ranking email
higher and citing no direct form evidence. Its public explanation supplies no
empirical support for the exact 50/30 ranking; both routes were unobserved in
the original input. The valid form branch demonstrates compatibility with the
unchanged task and execution rules. Earlier omission is not an explicit
assessment of impossibility. This singleton comparison does not prove a stable
causal prompt effect or calibrated probabilities, nor explain the unreturned
private reasoning of the historical GPT-6-Sol output. Removing profile examples
alone did not resolve omission in this batch.

Exact provenance for both earlier Explore observations is in
`.context/wmh-explore-contact-provenance-20261008.json`. Original and no-example
forecast receipts are under `.context/wmh-explore-probabilities-20261008/`;
focused public reasoning is under `.context/wmh-explore-form-rationale-20261008/`.
Offline verification checks complete forwarded messages, actual model, xhigh,
unchanged 16,384-token budget, disabled response cache and validators for all
three calls. There were three calls and no retries. Registered prompts, runtime
defaults and production remain unchanged. The RCA remains open.


### October 7 parallel Explore ablations of high unresolved-route probability

The user requested parallel ablations to explain the high probability of finding
no contact route, keeping GPT-6.1-Sol xhigh and only the approved execution
assumption. Twelve independent child processes ran one condition each, with
all twelve intervals overlapping from 2026-10-08T00:28:19.821531Z through
00:29:21.728361Z. All proposals pass Rose typed output validation and the owning
branch/patch parser. There were twelve calls, no retries, repairs, fallback or
response-cache reads/writes. The source was the original public Explore input
with 18 visible messages and five matched examples/contexts. The fresh control
retains its exact bytes. Input ablations have verified path-local edits; the
system ablations retain the distribution/rationale/approval contract.

Contact-route failure is defined here as unresolved route plus incomplete
research, not total absence of useful research or actual absence of a route.
The baseline is 48% published email, 45% route unresolved, 7% partial extraction:
52% fail to establish a contact route. Endpoint categories below are manually
grouped after generation; no event labels were supplied to the model. Both-form
and-email is a separate disjoint branch, avoiding double-counting. No form-only
branch was generated in this batch.

| Change | Email only | Form and email | Route unresolved | Incomplete | No contact established | Delta vs control, points |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh unchanged full Explore control | 48% | 0% | 45% | 7% | 52% | +0 |
| Change research depth quick to deep | 50% | 0% | 42% | 8% | 50% | -2 |
| Remove authentic/verified wording from delegated goal | 60% | 0% | 32% | 8% | 40% | -12 |
| Remove visible history | 65% | 0% | 35% | 0% | 35% | -17 |
| Remove five examples and matching contexts | 65% | 0% | 35% | 0% | 35% | -17 |
| Empty current state content | 50% | 0% | 43% | 7% | 50% | -2 |
| Empty initial context | 60% | 0% | 35% | 5% | 40% | -12 |
| Empty task.instruction | 60% | 0% | 30% | 10% | 40% | -12 |
| Remove only system private-fact restriction | 50% | 0% | 40% | 10% | 50% | -2 |
| Remove native system prefix | 55% | 0% | 37% | 8% | 45% | -7 |
| Empty task.tools | 60% | 0% | 40% | 0% | 40% | -12 |
| Request form/email comparison in probability description | 60% | 25% | 15% | 0% | 15% | -37 |

The strongest observed shift is the probability-description request: changing
only its placeholder to ask for form/email probability comparison and omitted
channel explanations gives 60% email-only, 25% both form/email and 15% unresolved.
The original world and task constraints are unchanged. Its previous standalone
call gave 50% email, 30% form, 20% unresolved. This repeated qualitative result
supports sensitivity to the elicited alternatives; it is not calibrated
probability or a replicated matched statistical estimate. No execution policy
requiring success or specific branches was added.

Removing visible history or the five examples reduces contact-finding failure
to 35%, while removing goal authenticity/verification wording reduces it to 40%.
Quick-to-deep, removal of current state and removal of the private-fact rule each
leave failure near 50%. The goal-language ablation preserves public publication,
citations, read-only scope and the prohibition on inferring personal email; it
does not erase all accuracy requirements elsewhere. Root-instruction removal
retains duplicate root goals in other blocks. Effects are not additive.

The public explanations repeatedly cite that an exact endpoint is not already
established in the visible history as the reason discovery remains uncertain.
The baseline calls the missing authenticated endpoint nearly as plausible as
finding one; deep research gives the same argument without citing quickness.
The form-focused call instead considers a separately reachable form and cites
client-rendered contact-link extraction as its smaller unresolved branch. These
are model-generated possible research limitations, not observed HTTP or tool
failures in this diagnostic. All model calls actually completed successfully.

The evidence identifies the model's stated conservative basis and strong
forecast-formulation sensitivity. It does not establish a particular sentence
as a deterministic cause, prove the historical hidden reasoning, or determine
the correct empirical contact-discovery prior. The RCA remains open. Exact
prompts, every complete observation, all public probability justifications and
the independent offline delta/wire audit are retained under
`.context/wmh-explore-ablations-20261008/`; the public report is
`public-ablation-results.json`. No registered prompt/default, benchmark,
production behavior or deployment changed.

### October 8 provider-prefix cache and owning-gate follow-up

The user's cache question was reproduced with six actual GPT-6.1 Sol xhigh
calls through Rose, using two saved fundraiser inputs and disabled DEMO
response replay. Original and ordering-plus-affinity pairs read zero cached
tokens; the explicit shared-task breakpoint pair read 1368 tokens on its warm
13429-token request. This is a request-layout/cache-affinity repair, not a
probability calibration or fundraiser success. Complete logical evidence,
system policy, native output validation and output budget were preserved.
The WMH adapter recurrence and permanent controls are recorded in
`2026-07-23-provider-cache-affinity-not-scoped-to-one-sequence.md`; portable
receipts are in
`docs/plans/active/wmh-evidence-20261006/wmh-provider-prefix-cache-20261008.json`.

The first full owning blackbox run passed native 37/provider 89 controls but
failed `partial_run_recovers_completed_tool_results_from_llm_contexts`. Two
archives can share `created_at_ms`; subtracting cumulative context length
produced equal or decreasing inferred tool timestamps. Final corpus sorting
then broke causal result order using lexicographic call IDs. The same existing
test, with archive milliseconds frozen, failed deterministically before the
fix and passed unchanged afterward. Recovery now keeps inferred timestamps
monotonic per producing agent; authoritative timestamps and missing clocks
retain their original behavior. A second permanent control covers a growing
context. Neither sleeps nor expected-order changes were used. The independent
review confirmed both cases. These inferred ordering timestamps are not proof
of physical event times. Exact red/green evidence is
`.context/wmh-provider-prefix-cache-20261008/corpus-order-{red,green}.log`.
No corpus rebuild, new benchmark or deployment ran in this follow-up; the
broader contact/fundraiser RCA remains open.

### October 8 activation and unchanged fundraiser run

The user authorized the original fundraiser with a fresh DEMO cache and a
30-minute task timeout. Before running, a new immutable local policy,
`rose-outcome-distribution-v2`, activated the exact previously tested system
overlay in `.context/wmh-explore-public-evidence-line-20261008/plan.json`,
case `01-proposed-line`. It requests comparative probability justifications,
assumes required execution approvals are granted, and includes the two
reviewed omission/public-evidence lines. Its policy SHA-256 is
`23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0`;
effective system SHA-256 is
`d76abcd5f096d65ea92e5f1e1aa538b5bae3643b4ea8618ba7e3a54eed24b470`.
Existing registered policies and root/general-purpose pool defaults were
preserved. The WMH pool alone pins `openai/gpt-6.1-sol`, xhigh, with no model
fallback. Its pricing entry prevents a new-model zero-cost table result;
harness cost is not an exact invoice or complete cached-input billing audit.

The artifact was locally bound to that model/policy without changing the
eligible corpus or RAG index: 12,510 trajectories, 179,150 observations,
RAG `trace-rag-71aa4160d086e717b2dd`. The exact task prompt, initial state,
evaluators, 2000-cent cap and deferred warm-network environment were unchanged.
Provider/pricing checks passed 88 tests; native checks passed 37; Ruff and
`git diff --check` passed. The new policy has not received a fresh 100-case
conformance qualification or probability calibration.

The first startup attempt exhausted the default 180-second health allowance
while the full native model was still loading. No task/root or prediction
was created. It was retired with exact ownership checks. The supported
600-second startup allowance let attempt 02 load in about four minutes;
the task execution timeout remained 1800 seconds. Both cache purges targeted
only fundraiser goal hash `f2f1d8d555013148`, returned HTTP 200, and removed
zero prior entries. Startup evidence is retained rather than counted as a
fundraising outcome.

Run `bbbdb300-bde5-4386-8463-cbef0cba9319`, root
`f8065e19-2fc5-4557-82a8-62dfadde5382`, failed at the timeout. The harness
observed 1842 seconds against the 1800-second cap; reported task duration
including fixture setup was 1972.5 seconds. The joined native retirement at
revision 15 confirms zero settled proceeds, no commitments, signed
instruments, pending wires or incoming Brex transfers. The committed history
contains eight Explore results, two read-only Browser results, three SMS
notifications and two email-send results. The first email was rejected for
the explicit sender mismatch; correcting it to `tamara@roselabs.ai` produced
a committed simulated send with 96% assigned probability. No investor-form
submission was executed. Thus this run does not establish that the earlier
form-discovery omission or submission behavior is fixed.

An independent audit found 75 native prediction attempts across 20 tool
invocations, 64 valid distribution proposals, zero protocol repairs and 15
committed transitions. State rebases reached six retries. Eleven native
attempt records ended without a model response: six bridge HTTP errors and
five cancellations. Logs separately establish a 600-second step timeout,
a 90-second productive-token timeout and an SSL bad-record-MAC transport
failure. These execution errors are not simulated no-route outcomes. The
shared-state rebase path repeats prediction after concurrent commits; the
observed volume and failures must not be interpreted as 75 independent
task outcomes or probability samples.

Final WMH response-cache accounting is 0 hits / 75 lookups (0%), 68 stored
responses and zero lookup-failure events. Across 68 provider usage rows,
prompt-cache reads are 0 / 1,813,251 input tokens (0%). The run's separate
agent-tree cache figure is 40%; it does not measure WMH cache reuse.

Native retirement is joined; benchmark and stack cleanup receipts are clean.
Cleanup observed the exact four-agent tree sealed/deleted and no browser
sessions; recorded processes, owned database container and volume are absent.
The run initially retained an archive warning after a deletion read timeout;
the subsequent repo evidence publisher successfully uploaded the frozen
bundle and verified the share link in a fresh browser, including reload,
with 34 root messages. Some archived cards retain IN_PROGRESS labels from
the cutoff snapshot; this rendered replay does not prove task completion.
No production code was deployed. Exact goals sent to the Browser tools,
committed observations, policy identity, errors, cache audit and replay
manifest are retained in
`.context/wmh-fundraiser-distribution-20261008/final-run-review.json`.
The portable receipt is
`docs/plans/active/wmh-evidence-20261006/wmh-fundraiser-distribution-20261008.json`.
The existing RCA and broader acceptance goal remain open.


### October 7 continued WMH dialogue and targeted public-evidence experiment

The user asked to continue talking with the WMH until a targeted change supports
prediction of discoveries during delegated execution, rather than penalizing
missing pre-execution verification. Three typed GPT-6.1-Sol xhigh diagnostic
follow-ups continued the previous context/forecast/conversation. Each retained
the full WMH context and explicitly used a diagnostic output contract. The
first prior diagnostic message was reconstructed from its validated JSON
fields; subsequent diagnostic responses were retained byte-for-byte. Fresh
forecast tests did not receive the dialogue or desired probability targets.

The first public self-explanation attributed omission to a prior-verification
interpretation and proposed a 98-character execution-time line. Its fresh
paired test returned 60% email and 40% unresolved in both conditions. After
being shown that result, the model acknowledged that newly invented inbox
evidence contradicts a blanket refusal to predict new information. It instead
described incomplete alternative generation and proposed a 100-character line
about deriving alternatives from scoped execution. That test also omitted
forms and increased failure to establish a contact route from 45% to 55%.
These self-explanations remain retrospective hypotheses, not original hidden
reasoning or a proved cognitive mechanism.

The third diagnostic generalized the previously effective form/email-specific
description comparison into an 89-character instruction to explain omissions.
It did not itself produce a form, but the fresh forecast now explicitly stated:

> A separate intake-form outcome is omitted because no exact form location is supported

The same forecast instantiated a newly discovered published mailbox despite no
address in the original input. This is direct evidence of an asymmetric
exclusion rationale in the forecast's public explanation. It supports targeting
the use of missing input verification as an exclusion criterion for public
discoveries; it is stronger evidence than the retrospective dialogue. It does
not reveal the original private reasoning or establish real contact routes.

The three model-proposed lines tested individually against the original
approval-only execution policy, in order, were:

1. "Model execution-time outcomes, not just prior knowledge; preserve facts, errors, limits and scope." (98 characters)
2. "Derive alternatives by simulating scoped delegate executions, not defaults; retain facts and limits." (100 characters)
3. "Explain probabilities against goal-implied alternatives; justify omitting plausible ones." (89 characters)

The targeted fourth comparison retained line 3 in both conditions and added
only this 98-character public-evidence execution rule:

"Simulate newly discovered public evidence; lack of input verification does not exclude an outcome."

| Condition | Email only | Form only | Both | Route unresolved | Research failed/incomplete |
| --- | ---: | ---: | ---: | ---: | ---: |
| Test 1 fresh control | 60% | 0% | 0% | 40% | 0% |
| Test 1 execution-time line | 60% | 0% | 0% | 40% | 0% |
| Test 2 fresh control | 55% | 0% | 0% | 40% | 5% |
| Test 2 derive-alternatives line | 45% | 0% | 0% | 45% | 10% |
| Test 3 fresh control | 62% | 0% | 0% | 33% | 5% |
| Test 3 omission-explanation line | 60% | 0% | 0% | 30% | 10% |
| Test 4 omission-explanation control | 60% | 0% | 0% | 32% | 8% |
| Test 4 add public-evidence rule | 65% | 23% | 0% | 12% | 0% |
| Minimality ablation: public-evidence rule alone | 74% | 0% | 0% | 26% | 0% |

The 23% form branch predicts discovery and read-only inspection of a
program-specific Embed application through https://www.conviction.com/embed,
including required founder name/email, company/project name and description;
it predicts no fields filled, outreach, submission, receipt or financing event.
The branch explicitly distinguishes that program application from a general
investment-intake route and does not establish Rose Labs eligibility. Thus
the fourth condition has 12% no destination discovery but 35% no general
investment contact established (23% restricted program plus 12% unresolved),
versus 40% in its matched control. Do not report the 12% as the failure rate of
finding a general fundraising contact. No actual web research was executed.

Removing only line 3 while retaining the direct public-evidence policy returns
74% mailbox and 26% unresolved with no form branch. The tested combination is
therefore a promising candidate for this case; these singleton comparisons do
not prove either line is universally necessary or establish stable calibrated
probabilities. Existing established facts, the private-company/pre-existing
record prohibition, genuine-error semantics, approval assumption and delegated
read-only scope remain operative. The rules prescribe no event labels, required
success, branch coverage or numeric weights.

There were twelve model calls: three diagnostic follow-ups and nine fresh
forecasts, with no retries. Actual model, xhigh, 16,384-token budget, disabled
cache, exact forwarded context/deltas and Rose typed validation are verified for
all; every forecast also passes the owning distribution/patch validator. Each
paired test's two model intervals overlap. The extra comparison quote in the
third dialogue is correctly located in the diagnostic question, not the
original WMH task payload; `citation-location-audit.json` records that distinction.
All categories were assigned after generation. This is candidate-policy evidence,
not a completed RCA, calibrated probability proof, or benchmark repair.

The public consolidated report with all conditions, every justification, exact
tested lines and dialogue replies is
`.context/wmh-discovery-dialogue-20261008/public-experiment-summary.json`.
Detailed forecast receipts are under `.context/wmh-explore-dialogue-line-20261008/`,
its `round2` and `round3` counterparts, `.context/wmh-explore-public-evidence-line-20261008/`
and `.context/wmh-public-evidence-without-omission-20261008/`. This continues the
existing open case. No registered execution policy, runtime default, benchmark,
production behavior or deployment changed.


### October 7 user-proposed discovery-line comparison

The user proposed asking the world model to use its best judgment to fill gaps
likely discovered during execution of an Explore, coding, browser or other
world-facing tool, requested a compatibility check, and authorized measuring
the resulting probabilities. The earlier 100-character single-line experiment
cap was retained using this exact 98-character compression:

"When simulating tools, use your best judgment to fill gaps likely resolved during their execution."

Inspection of the complete system and user blocks found no direct conflict for
this public read-only Explore call. The existing realistic-result simulation
rule already allows discoveries; consistency with known facts, no successful
side effects for failed calls, the narrower private-company-fact/pre-existing
private-record prohibition, and the delegated no-contact/no-form-filling scope
remain operative. The general line does not override those narrower constraints.
The compatibility audit records the exact user proposal, compressed insertion,
existing clauses and delegated goal. The earlier subjective 80% discovery prior
was not supplied to the model, and no event labels or success targets were added.

One fresh baseline and one insertion call ran concurrently with the original
94,345-character user payload unchanged, all five examples/contexts and all
history retained, and the same approval and comparative-rationale instructions.
Both used actual GPT-6.1-Sol, xhigh, 16,384 output tokens and disabled response
cache. Both passed Rose typed output validation and the owning distribution
parser, including patches. There were two calls and no retries. Independent
offline verification confirms exact forwarded messages, the single-line delta,
actual model/settings, and overlapping intervals from
2026-10-08T00:43:59.752291Z through 00:44:58.748651Z.

| Condition | Email only | Form only | Form and email | Route unresolved | Incomplete | No route established |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh full control | 62% | 0% | 0% | 38% | 0% | 38% |
| Add discovery line | 60% | 0% | 0% | 34% | 6% | 40% |

The insertion did not improve this sample or elicit a form branch. Zero mass
here means the generated proposal omitted that alternative, not a separately
elicited declaration of impossibility. Both positive observations instantiate
a newly discovered public hello@conviction.com mailbox; this is virtual-world
generation and not a live-site verification. Every state patch is empty and no
contact or form submission is predicted. Thus general public fact generation
was already occurring in the baseline.

The insertion's 60% mailbox justification still says its "exact presence and
suitability were not established in the visible history". Its 34% unresolved
justification cites a quick pass that confirms thesis/role while contact
controls or program links fail to expose general intake. Its new 6% partial
research branch cites hypothetical client-rendered page extraction failure,
not an observed tool failure. The baseline's 38% unresolved justification cites
the earlier homepage-only prospect result and quick research. The generic
discovery sentence alone therefore did not resolve the observed form omission
in this controlled comparison. A two-point difference from one call per arm is
not a stable effect, empirical calibration, or proof of a prompt conflict.

This continues the existing open RCA. Archive searches for "could not verify
dedicated investor intake form published email" and "world model simulated
discovery missing context contact routes" both returned this case; no new case
was created. The exact prompts, compatibility audit, full observations and wire
receipts are under `.context/wmh-explore-discovery-line-20261008/`; the reviewed
public table and every probability justification are in
`public-discovery-line-comparison.json`. The runner and independent audit are
`.context/wmh-explore-discovery-line-20261008.py` and
`.context/wmh-explore-discovery-line-review-20261008.py`. Registered policy,
runtime defaults, benchmark and production remain unchanged; no deployment ran.


### October 7 diagnostic follow-up on omitted intake-form probability

The user requested asking the same model why its forecast assigned no intake
form probability. One GPT-6.1-Sol xhigh follow-up included the complete previous
WMH system and user context plus its exact 9,231-character prior response from
the discovery-line condition. The only system addition explicitly switches
the follow-up output contract from a transition distribution to a diagnostic
explanation. No revised probabilities were requested or generated. The original
Explore goal, examples, history, approval and discovery lines remain in context.

The answer passed live Rose.complete/collect structured output handling with a
strict Pydantic DiagnosticReply caller schema. There was one captured wire call,
the actual model and xhigh effort match, the 16,384-token output budget is
retained, and cache reads/writes are off. Four cited source clauses all match
the original prompt or prior response exactly. Unlike the original forecast,
the diagnostic call deliberately requests a typed explanation response format;
it is not another controlled probability comparison.

The model's exact public answer is:

> I generated alternatives around a published inbox, an unresolved contact route, and incomplete page extraction. The visible history supported Conviction’s thesis and Sarah Guo’s association, but had not verified a specific contact channel. Favoring email was a modeling choice; omitting successful intake-form discovery was not required by the prompt and was not justified as impossible.

Its form_discovery_prohibited field is false. The omission_vs_zero explanation
says the form was omitted from generated alternatives, not assessed as having
an evidence-based true probability of zero. It identifies the delegated goal's
"ideally an intake form or publicly listed email" as explicit permission, and
"Do not contact Conviction or fill any form." as restricting action rather than
discovery. It supplies no deeper causal explanation for favoring email beyond
calling it a modeling choice.

This is a retrospective public self-explanation generated under an explicit
diagnostic output contract, not captured original hidden reasoning or proof of
the original omission's cause. It neither calibrates the original probabilities
nor establishes a permanent correction. The existing RCA remains open. Exact
follow-up messages, typed schema, original response hash, wire settings, public
answer and verified quotes are under
`.context/wmh-intake-omission-followup-20261008/`; the reviewed answer is
`public-answer.json`. No registered policy, runtime default, benchmark,
production behavior or deployment changed.


### October 8 publication checkpoint and role-scope diagnostic

The user requested a draft PR containing the current WIP and continuation
instructions. This RCA remains open; no merge or deployment occurred. The
latest full 1800-second fundraiser still settled $0. A subsequent five-minute
cache-only baseline also settled $0, with 1,367/16,341 metered WMH input tokens
cached (8.365461%), 10,978 output tokens and DEMO 0/4 lookups. Two cancelled
predictions had no final usage; do not treat the metered totals as complete
billing. Its native session joined revision 2 and both cleanup receipts were
clean. The durable FE replay was verified with 20 messages.

The separate user-requested role-scope diagnostic made two GPT-6.1 Sol xhigh
Rose.complete calls with strict typed public answers, DEMO disabled: 92,041
input, 13,394 output and zero cached input. Exact browser goals and validated
public quotations are in
`docs/plans/active/wmh-evidence-20261006/cache-optimization-20261008/role-confusion-diagnostic.json`.
The original Conviction forecast assigned 78% to no verified route, 18% to
email pending approval and 4% to email sent, omitting forms. Its retrospective
public answer did not establish literal actor/simulator identity confusion;
it questioned dependence among prior negative searches and extrapolation of
Andy-specific approval failures. The latest read-only Rose browser forecast
predicted new public docs at 27%, contradicting a blanket ban on new public
facts. Subtle normative leakage from actor verification requirements to
simulator input-only verification remains possible, not proven or ruled out
by this diagnostic. The diagnostic itself clarified roles and is not captured
original hidden reasoning or a causal A/B test. No runtime prompt changed.
The full run's two distinct browser invocations were read-only; absence of
submission is not evidence that a submit call was rejected.

Resume from `WMH_HANDOFF.md`: iteration 1 cache marker is active and tested but
its benchmark never started; iterations 2/3 are unapplied reviewed patches.
Finish the identical-control cache experiment, integrate current main
carefully, then resume matching full corpus/conformance, unchanged fundraiser
and viewer-visible replay acceptance. Deferred warm-connection changes remain
notes only.
