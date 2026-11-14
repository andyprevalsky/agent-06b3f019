---
id: 2026-10-29-it14-bu051-historical-diagram-count-evidence-unestablished
date: 2026-10-29
title: It14 BU051 reaches its browser budget with historical diagram step counts unestablished
surface: agents
component: browser-verifier-visual-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: verifier receives one current screenshot and path-only historical screenshots; their missing step-count evidence is observed but a causal transport repair is unproved
symptoms:
  - Browser step budget reached 100/100
  - Low progress score 0.00
  - step_count zero means unverified
  - User paused the browser agent
tags:
  - polar
  - it14
  - origami
  - screenshot
  - verifier
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent 3464a9ab-3428-45df-a842-2afe7b2ebb25
  - fleet run 20261029-021923-31718
  - plan: original archive 421162ab113a38606d2657d5c734d2d8dc5b2a8183882c2d3ecca40d7e58fa79
repro: none-recorded
status: open
---

## Problem

The unchanged task requests exactly one photo- or diagram-based origami tutorial
for each of twelve Chinese Zodiac animals, with clearly numbered steps, no video,
and no tutorial exceeding thirty steps. The executed catalog explicitly sets a
100-browser-step budget. Job r001-j0001 records canonical FAILED at
2026-10-29T03:16:17.407499Z, infraFALSE. The native root is PAUSED, not COMPLETED
or FAILED; its recorded duration is2600.7seconds. These are distinct from the
older It13 BU051 unsealed infrastructure failure.

Original normal manifest SHA256
8ffb6cb19c883c5200fa8e350143766c482073b45dc72d1df5afc6bedeb160fe and all
seven member lengths/hashes independently verify. The run.json SHA256 is
79288217530885f6526316406f69fa4a488f74c60211289587d53fc81f2cef9c.
An already-captured local Mouse image was privately inspected after the coordinator clarified that original RCA evidence could be viewed. No new capture or network call occurred.

## Diagnosis

The observed path is native screenshots/actions -> browser verification ->
continued OCR/actions -> the existing 100-step pause -> benchmark evaluation.

At02:39:39.665008Z, the exact encoded verifier request78acedaf5033 is captured
in worker.log line31462. Its decompressed309980bytes verify SHA256
4b600cefe23bd2f870d37635926ca98630e85001b3c7c7011512c40fc73eff07. There are
five model-facing messages and exactly one image block: the current final Pig
viewport. Fifteen successful screenshot action receipts exist, at steps9,12,27,
32,34,36,39,41,43,45,47,49,51,53,57. Historical diagram screenshots are represented
through action-history paths rather than additional image blocks. The actual
request includes native observation/JavaScript evidence as well; this is not an
inference from the text-only browser_verifier_input projection.

The exact response update at worker.log32720 verifies SHA256
a94f2f2d0184f74a21fe0518bd95155ea188172953b9e8c0292642e81806600c.
It returns task_completed=false and score0.5. Its twelve extracted entries assign
Pig eleven steps and the other eleven animals zero, explicitly describing zero
as unverified, not a real count. It accepts the twelve diagram URLs and absence
of video, but says earlier screenshots are only paths and their empty DOM
snapshots do not establish the numbered-step ceiling. No completion was falsely
accepted at this point.

Executed source service.py494,607-624 intentionally forwards the current
screenshot. Preserved checkpoints carry DOM, and _execute_screenshot records
success/file_path into action history while returning screenshot bytes to its
immediate caller (service_actions.py4440-4455). This explains the observed
representation. A subsequent bounded lookup decoded all original request image blocks into four
unique local images: three earlier actor images and the final Pig viewport. The
Mouse image from action27 (130242bytes, SHA256
`db0789e6a015cf17d21c2ae6265b560ad658c85bd9fd26e7a18ecb18e32d08f6`)
is present in encoded actor calls27–31 and visibly labels steps1–15 through
finished. It is absent from the verifier request, whose raw response calls the
Rat count unverified. This proves one omitted load-bearing historical visual
fact, not complete evidence for all other ten animals or a controlled task
outcome. No original-task or model replay was performed.

The actor continues with OCR and returns partial counts. At03:06:20.204315Z an
evaluate reaches its15second bound, with a TargetClosedError in stall probes;
generic recovery executes. Subsequent state capture and evaluations succeed,
including Rat and Ox OCR outputs. The packet does not establish that this
isolated timeout caused the incomplete twelve-animal answer.

The driver then prints100/100 and pauses the root. Backend POST pause is
03:08:46.544Z with200 at03:08:46.833Z; workflow PAUSE follows03:08:46.845963Z.
The final actor output is absent. The runner reports Low progress score:0.00,
matching the root progress field, not the internal browser verifier's0.5.
Source run_benchmark.py5090-5114 owns the step-budget pause;6345 rejects low root
progress;15626-15666 gates declared evaluators on the earlier result. Thus no
three-rubric semantic verdict is established for this run. The canonical FAILED
is preserved without inventing C1/C2/C3 failures. Summary zero LLM calls/tokens
is not evidence of no execution: the original worker contains real completion
calls, actions, and the hashed verifier exchange.

Archive searches used `origami paused step budget`, `benchmark PAUSED max
browser steps`, and `origami screenshot verifier`. The July20 productive-checkout
ceiling case and October28 R23 unresolved-screenshot case were read, including
Solution/Human feedback. Neither establishes this incident's cause: the former
changed a distinct ceiling, while the latter proved a provider file-path mismatch
not observed here. This is a related visual-evidence limitation, not a proved
recurrence of either repair.

## Solution

The task outcome remains OPEN. A scoped historical visual-evidence source repair
was independently GROUNDED and applied on an isolated source85 branch; no
prompt, schema, task, budget, judge or model change is included.
The exact request and private Mouse-image inspection establish one omitted
load-bearing historical visual fact. The unchanged-task outcome comparison remains missing. The permanent owning
regression now reuses the exact original Mouse PNG: source85 omits it, while the
candidate admits it through the actual screenshot executor, ActionHistory,
verifier privacy projection, multimodal converter and Anthropic/Responses
transformations. This is causal transport proof, not a model or task outcome.
A general visual-history capability would require explicit provenance, privacy,
selection and bounded admission design, then actual causal controls; it cannot assume all other unseen diagrams prove the requested count ceiling.
The visible OCR results do not establish all twelve tutorials before the existing
budget ends. No benchmark PASS, cap increase or altered evaluation is claimed.

## Human feedback

The coordinator required original sealed evidence, exact multimodal input rather
than a text-only projection, separation of native status from canonical judgment,
and no cap/criteria/OCR heuristic or speculative prompt fix. The coordinator
clarified that the scorecard image-output restriction does not forbid private
inspection of already-captured RCA images. The original live source remains
frozen; no provider/model/browser/DB requests or new image capture were authorized. Historical source-family clocks and original outcomes remain.

## Reusable lesson

Inspect the actual multimodal request and native completion state before blaming
missing historical images or interpreting a benchmark failure as a semantic judge
verdict.


### Scoped R51 repair and independent review

Exact six-file patch SHA256
`b5374dd70f60409991b3dd2eeaac3ffbe47b7c5e88e5d06a7393657158fdc0d7`
was independently GROUNDED as IT14-BU051-HISTORICAL-VISUAL-RECEIPTS-V1. The
reviewer verified all six outputs and reran the registered original-image
control on both source85 and candidate. Baseline failed with `Original captured
historical image omitted`; candidate passed. Seven new plus four existing
registered controls pass. Independent extra pixel-limit, current-frame dedup
and clear-reset checks passed. All work is offline.

Only successful explicit native screenshots enter a task-local sidecar, bound
to the same DOM owner, task, session, URL and unchanged before/after target.
Each valid PNG is bounded to1MiB/four million pixels; the sidecar holds at most
twenty,4MiB/sixteen million pixels, evicting oldest whole receipts. Exact same
URL-and-byte duplicates are replaced. The current screenshot retains its prior
priority; historical images are labeled historical, not completion authority.
Private entry suppresses even earlier public screenshots. Arbitrary result
metadata cannot authorize raster delivery. No remote image fetch is added.
Generic action history and durable pause data gain no images: restore and clear
discard the sidecar, intentionally preserving the existing durable policy.

Personally opened references: OpenClaw replay-message-window.ts60-137 and
inference-stream.runtime.ts324-337; Codex guardian/review_session.rs580-668 and
context_manager/history.rs1068-1095; Hermes browser_tool.py1251-1292 and
vision_tools_history_budget.py1-70. They support owned native imagery, bounded
projection and privacy. Contrary Hermes context_compressor.py1600-1650 strips
old media for an already-consuming actor; this verifier is a separate consumer.
Thresholds are conservative local policy, not borrowed model-token guarantees.

Up to4MiB historical PNGs plus the existing current frame may be sent again at
each verification. At10k maximally filled tasks this is roughly40GiB raw retained
bytes before base64/Python overhead; no throughput or token-cost qualification
is claimed. Before/after target identity cannot prove absence of an away-and-back
navigation race. The original PAUSED100/progress-based FAILED/infraFALSE, absent
all-twelve-count proof, and historical publication gaps remain unchanged.
