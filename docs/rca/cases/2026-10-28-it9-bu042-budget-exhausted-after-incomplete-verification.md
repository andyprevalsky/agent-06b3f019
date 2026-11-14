---
id: 2026-10-28-it9-bu042-budget-exhausted-after-incomplete-verification
date: 2026-10-28
title: It9 BU042 reaches 100 steps after incomplete vaccination evidence
surface: agents
component: spawn-browser-agent-v3 completion investigation
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: recorded task exhausts authored 100 steps after verifier rejection; safe causal repair not established
symptoms:
  - Agent status FAILED (expected COMPLETED)
  - Max iterations (100) reached
  - Native browser task did not complete successfully
  - typical initial rabies vaccination age remains unverified at last completion attempt
tags:
  - polar
  - it9
  - bu042
  - max-iterations
  - incomplete-evidence
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent d83ccb52-05c7-4c2a-8dd7-32586a93648f
  - fleet run 20261028-075834-14228
  - plan: subset sha256 dd0944b7cc66907e276b38ee7fae4303efe1f1448f671d67301ad127bb80a3d1
repro: none-recorded
status: open
---

## Problem

R22 reads the original failed BU042 repetition1 and same-source PASS sibling.
The parent subset is an exact five-file extraction from original archive SHA256
`89fa48c2cfd08df6edca8077c7b8f4c288764cf88f9617ce360950b3b55d6db3`.
All five member hashes and byte counts match its receipt. Failed run.json SHA256
`51652957ef4b4c37b2a9fa897cdfb7b17c76faf42a364afc1cda0f9d5c41272f`;
sibling run.json SHA256
`c0275611431254f1fba5cb91682115b6ddc781633014fb99ef2cd812f53424fe`.

Failed root d83ccb52-05c7-4c2a-8dd7-32586a93648f, child
a433a903-eb0e-563f-8fe0-1b54e8b8b604, fleet075834-14228, jobr001-j0027,
status FAILED, passed=false,2423.9s. Sibling root
6d8ffa6f-49c8-43de-aaa2-5a5859b85781, fleet075834-14313, jobr002-j0057,
COMPLETED, passed=true,1722.3s. Campaign summary says infra=false and
resources_released=true for both. Wrapper status passed is not task PASS.

Exact catalog task (unchanged):

    I'm a first-time cat owner preparing thoroughly before bringing a cat home. To ensure I have all essential information, please help me address the following points by finding detailed and credible online resources.:

    Dietary Needs: Find one comprehensive article or blog that clearly outlines both the key nutritional requirements for a healthy adult indoor cat and foods that must be avoided. Summarize the main points briefly.

    Health and Vaccinations: Provide a list of core vaccinations recommended for indoor cats based on reputable veterinary sources (e.g., AVMA, AAHA). Clearly indicate the typical age for the initial vaccination, the recommended intervals for booster shots.

    Common Hazards: Identify five common household items or substances that are hazardous to cats.

    Behavioral Needs: Find one authoritative webpage offering practical advice on preventing destructive cat behaviors, such as furniture scratching and aggressive playing.

    Grooming Requirements: Describe the recommended grooming routine for short-haired cats, including suggested grooming frequency and recommended grooming tools or products.

    Emergency Preparedness: Locate clear guidelines provided by veterinary or animal welfare organizations on managing cat-related medical emergencies (e.g., poisoning, injuries, sudden illnesses) before reaching veterinary care.

Authored max_steps.browser=100. No authored min_steps. The three Polar rubrics
and threshold1.0 remain unchanged. This investigation provides no clinical
advice and makes no external claim that a particular schedule is correct.

## Diagnosis

Observed terminal chain, not a completed causal RCA. Zero-based indices below
refer to original logs.messages. Failed run has304messages and max observed
steps_taken100. At249, the browser verifier rejects incomplete schedule,
behavior and emergency evidence. At286 it again rejects; its stated remaining
gap is a typical initial rabies vaccination age from a veterinary source.
At291 the actor navigates to Bing; evaluate293 reads VCA search snippets. Its
step counter is100. The snippet for Kitten Vaccine Schedule says a vaccine was
received at least12weeks old and rabies is due again one year later. No further
attempt_completion follows. At294 the browser reports Max iterations(100),
at301 native success=false, and303 the parent receives Native browser task did
not complete successfully. Worker logs record max exhaustion08:51:48.761485Z
and later root failure. The subsequent browser cleanup error is not the first
terminal failure and is not reclassified as the task cause.

Earlier tool errors exist: two Kernel proxy navigation failures, one evaluate
15s timeout/recovery and one no-focused-target error. Later successful actions
continue through100, so correlation alone does not establish any one as the
cause of exhaustion. No timeout/cap increase or proxy fallback is proposed.

The supplied run contains recorded verifier input projections and output
reasoning. Handler.py11753+ requires score>=1 and explicit task_completed=True.
Its max-step epilogue12774+ reports exhaustion;12787 only runs a best-effort
synthesis verifier when latest_structured_response is None. Here a partial
response from earlier verification exists, so no final synthesis is requested.
The terminal keeps that partial result with its explicit statement that initial
rabies age is unverified. Source semantics do not turn max-step synthesis into
successful completion even if data becomes more complete.

This is a possible boundary for further controlled investigation, not proof
that the final snippet completed every requirement or that a final verifier
would accept it. Making another actor step or promoting a partial result would
change the authored execution contract without the required causal evidence.
No original final-verifier provider response exists because that call was not
made; this is not alleged missing capture.

The PASS sibling uses a different sequence and schema shape. It also receives
an explicit rejection at202, then produces Cornell/AAHA/VCA evidence and a
successful verifier at228. It completes before100 with all rubric results
passing. This shows a feasible observed route, not a controlled one-variable
experiment or model-intelligence classification.

Archive searches after original evidence intake:
`Max iterations (100) reached browser evidence vaccination` and
`verifier missing evidence rabies initial age browser`.
Opened the October25 model-abort/mislabeled-max case and September19 keystroke
budget case, including Solution and Human feedback. Neither boundary is shown
here: this actor reaches100 and is not typing individual characters. They are
relatives in terminal/budget space, not demonstrated recurrences. R10 completion
and R7 evidence cases are likewise leads, not a reason to weaken this rejection.

## Solution

No runtime, prompt, task, timeout, minimum, cap, grading or provider change.
No paid or model replay. A deterministic general repair is not justified by
this trace alone. The next permissible causal work must isolate an owned
mechanism using the exact same contract and establish red/green without merely
allowing extra steps or declaring the last snippet sufficient. The original
FAILED result and distinct passing sibling are preserved.

Local `.context/r22-it9/evidence.json` stores hash-indexed original projections.
The five-file subset is sufficient for the observed terminal chain; it does not
contain full worker files referenced by runtime manifests. No additional files
were requested because no current causal test requires them. Full task outcome
and safe repair remain OPEN. Author token usage UNMETERED.

## Human feedback

The parent assigned only carried BU042r1, required exact original evidence before
archive searches, forbade cap/prompt/task hacks, provider/model/browser/DB calls,
new paid benchmarks, active parent changes and reviewer wakeups without capacity.
Chart work and prior R17 repair remain on their separate branches. No user
approval or clinical conclusion was inferred from a sibling PASS.

## Reusable lesson

Distinguish a genuine authored step-limit exhaustion from a mislabeled early
abort, and do not promote new terminal evidence without a verified completion
contract.
