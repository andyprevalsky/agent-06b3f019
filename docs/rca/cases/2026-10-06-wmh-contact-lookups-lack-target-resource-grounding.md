---
id: 2026-10-06-wmh-contact-lookups-lack-target-resource-grounding
date: 2026-10-06
title: WMH public-contact predictions lack target website observations
surface: harness
component: serve-world-model prediction and archive retrieval
classification: unresolved
problem_class: fixture-environment-data-mismatch
first_bad_boundary: WMH explore result at live history 13 falsely reports no verified Precursor route; missing-resource sensitivity reproduced, general remedy and fundraiser outcome remain unproven
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
has 179,169 rows; clock normalization did not change the sampled contact
outcomes. Literal `DEMO FIXTURE ONLY` appears in one separately retrieved
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

## Solution

No production prediction prompt, model selection, corpus artifact, seed,
evaluator, or timeout was changed. Full evidence remains locally under
`.context/wmh-failing-*`, `.context/wmh-screenshot-replay/`, and
`.context/wmh-contact-{direct-replay-pinned,goal-only,first-party-control}/`;
a portable comparison receipt is in the plan evidence directory.

The next authorized repair should establish a general resource-grounding and
observation-fidelity contract, then reproduce its accuracy in the permanent
WMH suite and matching inference conformance. The page-data control is
supporting causal evidence, not a hardcoded Precursor fix or a passing
fundraiser. General remediation and the exact unchanged fundraiser fail/pass
proof are still open. No production rollout has occurred.

## Human feedback

The user rejected the earlier speculative explanation and required reading
the actual WMH trace and underlying retrieved samples. They requested a real
diagnosis, authorized the separate code-card fix, and prohibited preemptive
prediction changes. Their supplied Founders Fund screenshot is not proof that
Founders Fund publishes a submission channel.

## Reusable lesson

Distinguish simulated source-availability predictions from fetched resource evidence, and isolate missing target data with an unchanged-request first-party control before blaming archived errors or model intelligence.
