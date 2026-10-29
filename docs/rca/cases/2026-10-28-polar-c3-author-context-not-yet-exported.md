---
id: 2026-10-28-polar-c3-author-context-not-yet-exported
date: 2026-10-28
title: Polar C3 contradiction attribution awaits original authoring contexts
surface: agents
component: investigation-evidence-availability
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: authoring-context versus persisted-summary boundary is unproven pending normal original export
symptoms:
  - polar-bu-016 r2 C3 says summaries contradict Success! Form submitted successfully!
  - polar-bu-033 r2 C3 says 40 cities contradicts 40 property addresses with repeated cities
  - polar perfect-score failed (2/3 rubrics)
tags:
  - polar
  - factual-claims
  - summary
  - evidence-gap
sources:
  - commit ca562dd8b9a259800980bbdc2205d873bc657d5e
  - agent 147a072e-bce7-48e7-ab87-7b0a8d66650a
  - agent 38f1cf47-0360-4d8c-898b-587d9d381951
  - plan: rows archive SHA256 940debcb561641539b765d7c78efc8a7c6e4a4735f5e44b2858b878b3fab2980
repro: none-recorded
status: open
---

## Problem

It8 frozen source ca562 records two genuine task FAILs with infra=false.
BU016 run2 r002-j0026, fleet20261028-050809-14933, root147a072e,
has row SHA256 a9e0b6da0389d6ae8067e6911a4525d87a4886ba5452f703cd1475eb8ed6f657.
Its judge C3 says chronological row50 shows the successful form confirmation,
while summaries52-53/59-60 claim the supplied final-state DOM excerpt omits it.
BU033 run2 r002-j0043, fleet20261028-051014-17527, root38f1cf47,
has row SHA256 dbd8a84329a51c971b40b1405a6c2bb37c4d44ecf19239192d26e002157cecfc.
Its judge C3 says row65 claims40cities, although row64 has40property addresses
with repeated cities and row67 identifies33LosAngeles addresses. Those are the
judge's quoted findings, not independently inspected original actor inputs.

Sibling run1 rows record PASS: BU016 rootaec747ff, rowSHA91567b00a1dbf5e82b43c73a9c28dba15f1788a64724085989397fb714210137;
BU033 root4d7b37e8, rowSHAae916f0bdf2bc4f8d7a233f0c7383874ea5f0a1040fb5368c62c8b8ed0347ee7.
A sibling pass is neither root-cause proof nor a basis to regrade either failure.
The immutable catalog SHA2560b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9
requires no fabricated facts contradicting the trajectory, independently of a
correct final submission or answer. Task definitions and criteria are unchanged.

## Diagnosis

OPEN preliminary findings, not a root-cause verdict. The problem_class metadata
denotes only investigation-local evidence availability pending normal export;
it does not assert a runtime capture defect or transport loss. No local causal reproduction
or outcome red/green has been established. The currently available packet holds
original result rows, not the raw actor/verifier requests, native observations,
persisted summaries or full judge request bodies. Normal existing exports were
requested from the launch owner. No early live, browser, provider or archive
query was made. This is an evidence availability boundary in this investigation;
it does not prove the original runtime failed to capture those requests.

Trace to compare: native DOM/action receipt -> actual actor or internal verifier
context and response -> persisted browser/tool/assistant summary -> full Polar
trajectory -> per-rubric judge input/output. Identify each contradiction's actual
author, role, browser task, source action index and outer chronological row, then
compare what that author saw with the independently projected judge evidence.
Do not treat the evaluator's quote as proof of actor fabrication, context loss,
or an incorrect evaluator. These two symptoms may have different causes.

The current projection code carries tool text, observation metadata and the
existing task-scoped native action index fields at ca562. Actual incident
request bodies and upstream admission limits remain unverified. The deterministic
context-summary formatter wraps supplied reasoning; which exact reasoning and
DOM reached these incident authors remains unobserved here. Thus neither an R6
receipt-identity recurrence nor a new projection defect is established. Earlier
BU016's unsupported File-example premise was a different recorded claim.
No model-intelligence classification is supported without the required controlled
call reconstruction/model-only evidence.

Archive searches: summary contradicts successful action evidence; citation
namespace step action receipt factual claim; Success! Form submitted successfully!
final-state DOM excerpt; 40 cities property addresses repeated city names.
Results include related DOM-evidence, tool-truncation and receipt-identity cases.
Those are leads; no shared first-bad boundary or recurrence is proved.

## Solution

No runtime or prompt patch. Preserve both genuine FAILs, their original clocks,
C3 criteria and sibling controls. The next evidence step is the normal immutable
export containing task/run.json, full actor/verifier/judge evidence and source
provenance. Reconstruct the actual authoring boundary offline before choosing a
fix. Any protected candidate requires the same owning-boundary RED/GREEN and
independent exact opened-reference GROUNDED review before application. Exact
unchanged task outcome remains unproved; no paid rerun or task/timeout/evaluator
change is authorized in this lane. Adversarial review of this preliminary record found its OPEN conclusion bounded
and required the investigation-local availability and source-only wording
clarifications above. The reviewer read the draft/status, not original rows or
raw incident records; this is not independent raw-incident verification.

Golden reference is not applicable yet:
there is no proposed approval-gated hunk or established causal mechanism.

## Human feedback

The delegated parent contract requires frozen isolated ca562 source, normal
existing exports only, separate attribution for the two contradictions and no
assumed R6 recurrence. It prohibits speculative prompt/task/budget changes,
provider/browser/paid reads or writes and regrading the original failures.
The initial investigation is bounded to30minutes with a15minute milestone;
an honest OPEN evidence gap is allowed when original requests have not arrived.

## Reusable lesson

Bind a contradictory claim to its actual authoring context before changing evidence transport or semantic policy.

## Normal BU033 export follow-through

The normal shard-01 export supplied packet SHA256
ab8c581e9bfaa058c46a9663b91a088626f860d6a5b8f62abb5a2914a99d9a8d.
The failed run.json SHA256 is
6b5ac80c47189c3f0cae190911d8855eeb9df67440cfec10d3049875e584a7e1;
the passing sibling is
9386c9cfffffb8ef749144eccaef63e57ead3f1cdff63936d92b7c76e326795d.
Both provenance records bind clean ca562 with workspace_patch_sha256=none.
The owner reports the normal original export archive matched its manifest;
the worker hashed the supplied packet/run bytes, not the full controller tar.

The original persisted ASSISTANT message64 (outer Polar row65), created
05:18:52.092Z, already says the page mentions40cities. Its metadata binds browser
task4a957a8c-f468-5690-96e9-abcbf960b56b. Previous TOOL message63 (outer64,
05:18:44.688Z, native action-history23) reports totalAddresses40 and40listing
rows, with repeated city names. Next TOOL message66 (outer67,
05:18:52.154Z, native action24) reports33LosAngeles addresses. Message70's
later summary quotes the earlier reasoning while its verifier outcome correctly
distinguishes40addresses from33LosAngeles addresses. Thus the earliest observed
wrong text is the persisted actor ASSISTANT claim, before deterministic summary
formatting. This supports retaining the genuine C3 failure; a correct final
33-address answer does not erase the trajectory claim.

Exact message-text SHA256 values are prior tool
bdcf3d1df0b6132bab093d3272c71a8d4aed72b1d36c919da5f2461d7a97c4c2,
actor claim4d5f1079a74e81069eafe518daa583e660a2578d6883ced5c34429da67e2e220,
and next tool03705795487bd53e85adbddb3dcd2419ebabd7fdc02d5a145b231a3bacfd634d.
These identify original evidence, not a model-capability diagnosis.

An executed offline control used the actual build_polar_trajectory and
run_polar_evaluator on each original message list and unchanged task/rubrics.
All three captured judge requests contain the prior native extraction, disputed
claim and later extraction. The judge double always returns failure. Both
original trajectories contain zero screenshots. This establishes supplied-data
projection continuity, not original HTTP byte parity, a semantic regrade or task
outcome proof. The saved tree contains only the root; the corrected control uses
None as actual _hydrate_semantic_evaluator_tree does for a single-agent tree.
The earlier root-duplicating control was superseded, not treated as exact parity.
No production/test source was changed and no paid call was made.

The deeper authoring request is still an explicit gap: worker log dump
bb9b00842068 at05:18:52.061166Z, call_site browser_use_step_14,
modelgpt-6-sol, message_count50, records payload_too_large:
1813020bytes exceeds the existing1000000-byte inline dump limit. Step13's
6f121803bf81 is similarly skipped. Earlier decoded dump payloads were hash-checked,
but precede this extraction/claim. This does not prove the actor lacked or
received complete evidence. A local-only scan of already exported durable dump
or cache members was requested; no live/R2/provider query or cap increase follows.
No model-intelligence classification, shared cause with BU016, R6 recurrence,
new harness fix or unchanged-task success is claimed.

Independent adversarial review opened compact original messages63/64/66/70,
the original judge excerpt and offline output. It accepted the bounded
before-formatter observation/no-patch conclusion and required the exact-author
request, HTTP parity and model-causality limits above. It did not independently
verify the full tar, decrypt an archive or query native/browser state. BU016's
normal shard-00 export remains pending; its quoted contradiction is still
unattributed. The overall case remains OPEN.

## Normal BU016 export and distinct verifier-input provenance

Normal shard-00 packet SHA256
0630564e05946c852d158496cd974b6c09dfcdefe460694e5a9ee6c72387f907
contains failed run.json SHA256
c7168519f6bcbbb18058e2f95ea8c47e717e8e5951a324ecc950ac238d407e03.
The earlier row's description did not identify the actual author of the disputed
omission claim. It is an internal verifier TOOL progress message, not a new
actor assertion. Its reasoning is later copied into the deterministic summary.

The captured verifier_browser request dump9c02364a55e6 at05:17:52.429398Z
contains106904decodedbytes; its encoded payload digest was checked before use.
The actual final-state DOM supplied in its user text starts with0.3pagesabove
and omits the submission confirmation. Older persisted read_browser_state
outer50/native action15 at05:17:49.187Z carries a different snapshot with
0.4pagesabove and Success!/Form submitted successfully! The verifier's progress
outer52 at05:17:56.937Z explicitly acknowledges native15's success and says its
supplied final-state DOM excerpt omits it. The external judge sees the older
snapshot but not the paired verifier input, and treats that statement as a
contradiction. This establishes distinct source contexts, not a semantic regrade,
a proven evaluator error or an unchanged-task after-pass.

The first owned representational loss is the ordinary check_progress result
return, which preserves reasoning/output but not the admitted text explaining
which final-state snapshot the reasoning refers to. The browser's progress
persistence consequently cannot pair them. This differs from BU033's original
actor claim and from the R6 native-versus-chronological index loss.

The mechanism repair preserves the already assembled/admitted browser-verifier
user text blocks with the normal result, scopes them to the existing browser
callsite, persists them through the existing private progress owner and labels
them as text-only verifier input with browser task and verification-call identity
in the Polar trajectory. It does not replace the older snapshot, alter reasoning,
change a rubric/score/model/schema/cap, invent screenshots or duplicate evidence
into the parent planner. System messages and image blocks are excluded. Synthetic
soft-completion/error returns have no fabricated input snapshot. The maximum-step
callsite can return this text, but no new max-step publication behavior is claimed.

The same permanent controls execute the actual check_progress return and full
admission body, actual handler progress call and private owner, then all three
actual Polar request builders. Original code fails four intended assertions;
the candidate passes unchanged. The full-body control exercises the existing
per-tool clipping and asserts retained text equals actual admitted model messages,
not the raw oversized tool result. Score0.5 and partial output remain unchanged.
The judge double always returns failure, so transport proof is not semantic or
unchanged-task outcome proof. Missing/unbound task/call, non-browser caller,
image-only input, secret masking and unchanged parent planning are covered.

Closest opened primary source: BrowserUse0.13.11 service.py1378-1385/1762-1780
pairs last_state_message_text with model_output/result/state in the same history
item; views.py488-495/545-585 serializes those paired fields with sensitive-data
handling. File SHA256 values are service
10f7c14458ed7089c49f34a06ad7b3ce12212a589d9d000c5cf4d9cc7ddd8479 and views
f08c9e96df9e346ba87c0cd3ceb79a7d3a6c1f7764083a367ca8e10bb65c43ce.
OpenClaw transport-message-transform.test.ts29-44 preserves toolCallId/content;
Claude structuredIO.ts100-117 retains input/tool_use_id/request_id; Codex
context_manager/history.rs1157-1174 preserves output/call/namespace distinctions.
These are scoped provenance analogs, not identical verifier policy or automatic
success authority. Hermes shared_metrics_efficiency.py250-267 distinguishes raw
and persisted output under tool_call_id, a supporting distinction only. Kimi's
local clone is absent; no missing reference was invented. Rose's stronger
existing secret masking remains the persistence owner.

The actual fixture carries28034textcharacters. A representative serialized normal
return using the reviewer's explicit default JSON serialization grows1038->31017bytes,
+29979bytes; the captured request JSON is106904bytes. These are offline serialized
measurements, not actual Temporal transport or billed tokens. Duplication adds
O(admitted text) serialization/storage/judge context and can pressure Temporal
payload limits; no arbitrary cap, universal2MB safety or runtime savings claim
is made. There are no new provider/service/page calls or per-guest fanout.

Original BU016 and BU033 FAILs, all clocks and missing media remain authoritative.
The case stays OPEN for unchanged-task outcomes and BU033's deeper authoring-call
gap. Owner local-only manifest inspection found no durable exported request dumps
for BU033's skipped IDs, so the existing exported trail ends there; no new native,
R2, browser or paid model calls were made.

Independent reviewer ph774zzc4essz3cdj3n09e0ck58h5b0b grounded exact six-path
patch SHA256250ab39182a3c7001adfe3fe643d20b3be780de531524343f5eb0b6ca53d8255.
The reviewer independently verified the original captured request and same four
intended baseline failures/candidate passes. Postapplication owning gates passed:
21 Polar/evidence/identity controls, six check_progress controls and four browser
privacy/context/cancellation controls. Original outcomes remain unchanged.


## R53: original It14 BU060 run2 authoring boundary

The normal sealed packet for r002-j0030/root
`f9138110-f912-4a30-a4f5-f07877092e49` binds executed source
`85d37fc8ab8e284459977debdef34348d825ef84`, workspace patch none. Archive SHA256
`b0126bfe07775ff4a9b90c0d0a02acbf9a65e86f4a488f57733979a0864fadb7`;
normal manifest SHA256
`9f73da1f2990e529264c62cba4ac93d7b786a9adaabe53df9744b994f6bfa5cd`.
All seven normal member lengths and hashes were independently verified. Native
COMPLETED after290.3seconds is distinct from canonical FAILED/infraFALSE: C1
and C2 pass, while C3 rejects a contradictory intermediate factual claim.

The task asks for current non-promotional Apple Music and Spotify Student and
Individual prices, local currencies and official country links for Singapore,
United Kingdom, Australia, Canada, New Zealand and Ireland. It does not authorize
fabricated facts. The unchanged C3 rubric explicitly requires no fabricated
facts contradicting the trajectory evidence; a correct final table does not
erase an earlier claim under that contract. No rubric reinterpretation follows.

The original author input/output is retained, unlike the older initial BU033
availability floor. Worker line9945 contains browser_use_step_11 dump60b62109d648
SHA256`94a4140a99bb85e4ced65fc78ae74953d025a703ff4d1bb80ec794723de3fe10`,
with request_id1126f19ae88f. Its model-facing messages contain11.98 at positions
10,11,34,38,40 and no12.98. In particular the preceding Spotify native extraction
returns its Singapore Individual recurring price as11.98/month after the trial.
The output's action.thinking and reasoning nevertheless say Spotify Singapore's
new price12.98 seems to match Apple, while selecting the next country URL. The
source configuration records gpt-6.1-sol-foundry; this is source attribution, not
a controlled model-capability diagnosis.

Persisted ASSISTANT index52/outer Polar step53 at03:24:40.364Z contains that same
claim. It is already wrong before the deterministic browser context summary
quotes it under Agent Reasoning. Preceding TOOL index51 at03:24:32.081Z has text
SHA256`1b1fa56e2333e221c8620296325a67cf4f063bfafb5129f9c0f4ea1f010bac6d`;
claim text SHA256
`5694c387ef6f7859e8f3ad0d662185631a3fd1f3ee312f24180040e0105d8a97`.
No evidence-loss or summary-rewrite mechanism is established.

Later internal verifier536b9f245e14 request SHA256
`f5000cf7642752f06a53e49620ad04903b1109c990ed2368469f9d6b53fd0e2e`
and response SHA256
`84a4e9da5b056a530c1e23d4637346d418c552a9c2ec382362c5d3dbb7cc6196`
produce task_completed=true, score1 and the correct Singapore Individual11.98
for both services. The completed root output retains the correct table. That
verifier request does not include the wrong reasoning string; it independently
checks task data, while the declared C3 judge assesses the full trajectory.
These different consumers and outcomes must not be collapsed.

A bounded offline call to the unchanged build_polar_trajectory over the supplied
root messages retains the11.98 native evidence,12.98 claim and correct final
table. Resulting text SHA256
`31610d2634ac0fcbac5b29c4e1721bea84ecf0a2492518dcee90434ccafd379f`, with
zero images. This verifies projection continuity only, not original judge HTTP
byte parity or a controlled semantic replay. The original declared result
explicitly cites all three and scores C1=1,C2=1,C3=0. Separate raw judge request
bytes were not identified in the normal packet.

Searches used `Spotify Singapore 12.98 contradiction` and
`correct final answer intermediate reasoning factual error`. This is an additional
observed author-claim occurrence related to the BU033 boundary above, not a
regression of R9's admitted-verifier-text transport repair. No runtime candidate,
new test lane, price-specific filter, reasoning deletion, prompt nudge, criterion
change, model replay or regrade is proposed. The deeper cause remains OPEN; no
model-intelligence classification is supported. The live source and original
outcomes remain unchanged. Tokens UNMETERED.


## R73: original It20 BU073 run2 bibliography claim

Original job r002-j0013/root dd5b8525-f0e8-4ea7-9238-d93b54e41d51 binds
executed source4016ffaf50aeee0eff1b242d9e348f54896fdc02 with no patch.
All seven normal manifest members were independently verified by size and hash.
Archive SHA256 is
4dce41558ad057a40175821a022f0b6c5d948f87c33eb181668d7ac093107eb2;
manifest SHA256 is
0c7dbfb11a32aa9e2aea3b97b01c274b3ee1cc84bccee3aa1bf5a43c0dd4566e;
run JSON SHA256 is
811949a019c5fd8804636a5d52997645571e5f1e807f71a2cc02a74c9e9398e4.
Native COMPLETED in1473.8seconds is distinct from canonical FAILED/infraFALSE
at19:30:38.425541Z. C1/C2/C4 pass; C3 rejects the intermediate factual claim.

The task asks for animals mentioned outside bibliographies in the relevant
Lagkouvardos and Tapia papers and in the cited2021 study. The generated animals
list schema preserves that restriction. Persisted assistant message69 at
19:04:08.001Z says “The article doesn’t include a bibliography” while planning
the next PubMed lookup. Earlier message64 contains References navigation for
Tapia's paper; later message117 contains the explicit References heading on its
MDPI full-text page. The later successful animal extraction does not erase
that earlier claim under the unchanged C3 criterion.

The original browser_use_step_21 request and actual output are retained together
in worker line6418, payload SHA256
 a37d93df698ba0c4ccb03babc7ef86964948e84248eb56ee55a4e21bf8954a30.
Its input message52 includes “navigate to References section”; its actual
output.action.thinking and output.reasoning contain the disputed sentence.
Thus the claim originates in the actor response before any deterministic
summary projection. The original encoded input/output supplies a narrower
boundary than an inference from the eventual judge explanation. It does not
establish a general model-capability cause or prove why the actor made it.

The later browser verifier request (worker13240, SHA256
f0d1d2a6cdb7aaa50081763b4d8ab8d18c5ff81c4bbb25288e57903b32d630cc)
does not contain that reasoning sentence. Its corresponding response
(worker13269, SHA256
1cb823a6ed5562de44a5a084a81d2c9ed5cc9cc0ba29981d3a8d052cda9b4f45)
returns animals=[mice], task_completed=true, score1. The final root output
preserves mice. The internal task-data verifier and declared full-trajectory
C3 judge have different inputs and contracts; their results are not collapsed.
The recorded C3 explanation explicitly names the early claim and later heading.
Independent raw declared-judge HTTP request parity is not established.

Archive searches used bibliography/Tapia and early-claim/trajectory-contradiction
vocabulary. The BU072 early-date case and this case's BU033/R53 Solution and
Human feedback were read. This is another observed retained-author-claim
occurrence, not proof of regression in a prior transport repair. No missing
output, overwritten answer or stripped author input is demonstrated. OPEN:
no safe general runtime candidate is justified. No reasoning deletion,
bibliography keyword rule, summary rewrite, criterion change, prompt nudge,
model replay or task regrade was performed. The correct final animal and
original C3 failure both remain. Live source unchanged; tokens UNMETERED.
