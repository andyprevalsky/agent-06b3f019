---
id: 2026-10-28-it9-bu029-original-evidence-pending
date: 2026-10-28
title: It9 BU029 C1 intake awaits original schema actor verifier and judge evidence
surface: harness
component: investigation-evidence-availability
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: investigation currently has a terminal C1 reason but no normal exported authoring or judge request bodies; runtime first-bad boundary unproven
symptoms:
  - polar-bu-029 r002-j0044 failed C1 with two of three rubrics passed
  - search remained filtered to Past Week
  - archive check looked for the phrase in titles not article contents
tags:
  - polar
  - it9
  - bu029
  - schema-scope
  - evidence-pending
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent 8f121a39-287e-4bc9-a4ab-42f80495eb33
  - fleet run 20261028-080447-19715
  - plan: row packet sha256 e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2
repro: none-recorded
status: open
---

## Problem

The initial intake below is historical; the normal-export follow-up at the end
supersedes its availability limitation.

R15 is a bounded read-only intake of It9 BU029 repetition2. The original row
records job `r002-j0044`, root `8f121a39-287e-4bc9-a4ab-42f80495eb33`, fleet
`20261028-080447-19715`, completed at `2026-10-28T08:26:07.307277+00:00`.
It records `task_status=FAILED`, `exit=1`, `infra=false`, `released=true`, with
2/3 rubric success and C1 failure. Its wrapper `status=passed` describes the
wrapper, not a task PASS. The original task FAIL is preserved.

The row's C1 reason says the October26 title/date was confirmed, but a PastWeek
search and archive title checks did not establish all article-body matches from
October27–28. This is the judge summary as reported by the row, not verified
actor evidence or an independently established causal diagnosis.

Raw failed-row SHA256:
`b2c24c7fed16bc16716d32cd6cfac4743d9d221fd837030d5bda025b6662553c`.
PASS sibling row `r001-j0014`, root `6041c186-aca3-4cfc-ae96-815e51182741`,
fleet `20261028-080446-19648`, raw SHA256:
`f01f625341237190280497a98350aaadcfcb8ee95dc0df8f76efb603226ff5e5`.
Both hashes match the parent's original-row verification packet.

Catalog SHA256 `0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9`
and prompt remain unchanged:

    Search the Barron's archive for articles containing \"value investing\" posted in the last 2 days, and list each title along with its publication date.
    website: https://barrons.com

The source task requires article-content matching, not title-only matching.
No implicit minimum is authored. Maximum browser budget remains100, expected
spawn_browser_agent and all three semantic Polar criteria remain unchanged.

## Diagnosis

OPEN at an investigation-local evidence availability floor. The current packet
contains terminal rows, not actual generated schema, actor input/history,
internal verifier calls or the three Polar judge requests/responses. This does
not imply a runtime capture defect, missing production evidence, a provider
failure, or a model limitation. Normal verified exports are pending and were
requested from their launch owner; no extra controller, guest, provider, DB,
browser, model or archive calls were made.

Executed source includes the independently introduced strict browser
`task_completed` field and terminal `is True` gate, plus R9 admitted text pairing.
The source's presence does not prove which values were delivered in this run.
Generated schema descriptions can still enter required-output instructions;
without the actual new schema and authoring context, earlier It8 R12 narrowing
is only a lead. It7 BU029 unsupported inclusion is another distinct lead, not a
proven recurrence. No old case was appended on the basis of a matching symptom.

Required next comparison, in order: original accepted task and schema-generation
request/result; schema actually supplied to the actor; native action observations
and actor uptake; internal verifier original goal, schema, admitted text,
`task_completed`, extraction score and output; all three exact external judge
inputs and outputs; corresponding same-source PASS sibling records. Bind every
claim to the original task/root/call identities and hashes. Preserve the
original clocks, grade and release state. Do not infer absence from the nine
other jobs not yet in this partial terminal packet.

## Solution

No causal fix or test is proposed in this intake. The launch owner was asked
for the already scheduled normal export of both BU029 copies only. Resume this
same case when those originals arrive. A later repair requires an owning
registered red/green reproduction and fresh exact independent opened-reference
GROUNDED review before application; the unchanged real task outcome remains a
separate requirement. No schema keyword rewrite, title hint, rubric change,
cap adjustment or automatic regrade is authorized by this record.

Local receipt: `.context/r15-it9/intake-receipt.json`; exact extracted rows and
catalog task are beside it. Work scope is BU029 only; token usage UNMETERED.

## Human feedback

The parent directed a bounded ten-minute original-evidence intake, with an
initial five-minute milestone. The earlier R12 diagnosis must be treated as a
lead. Row quotations must not be mistaken for raw incident parity. Request only
normal verified export evidence, preserve genuine task FAIL and infra=false,
and stop at an honest investigation-local OPEN floor if originals are pending.
No image output or new live/provider/controller calls are permitted.

## Reusable lesson

Bind the new generated schema, actor evidence and all judge inputs before
calling a recurring article-search symptom the same root cause.

## Normal export follow-up (supersedes initial availability floor)

The launch owner delivered the normal verified shard-01 export after the initial
intake. Packet SHA256:
`15de6fd69744f4313b59b60b15197e07195cd6eca33b96265a1a5f5005becdee`.
The owner reports original archive/manifest equality, export verification at
08:59Z and30/30 resources released. This investigation read only local copies;
no provider/controller/guest/browser/model calls or new artifact fetches.

Failed run.json SHA256:
`db4fc4f5c8dd4aacda6c4412638b2228895009f97d8d675fb840af9b52c73f7b`.
It has137 recorded messages, status COMPLETED but passed=false. Sibling run.json:
`96fc6309c6ba2d18056fdef190f637e8fba643206a33241df17db004e2e58850`,
99messages, passed=true. Indices below are zero-based indices in each original
logs.messages array. C1/C2/C3 scores are0/1/1 for the failed run and1/1/1 for
its sibling. No historical result was changed.

### Concrete evidence and disproof of the old lead

The failed root's stored response schema describes "Barron's articles containing
value investing posted in the last two days." Its article_title description is
"Title of a Barron's article containing the phrase value investing." It does
not require the phrase to occur in the title. This disproves the specific prior
R12 title-only schema wording as an established recurrence in this run. The
actual schema-generator request/response is not established by this stored
schema alone.

Failed index68 returns dated search results including October27-28 candidates.
Index108's executed JS filters all anchors with
`/value investing/i.test(a.textContent)` and returns matching=[], examining
archive link text rather than candidate article contents. Index119 provides
article-page text for the single October26 title. The browser completion
reason at122 explicitly says the October27 and28 archive pages show "no other
titles containing the phrase" and accepts this as the requested list.

The same index122 has a browser_verifier_input record containing three captured
texts of96204,230 and131393 characters. Those recorded inputs retain the archive
link-text matching code. Thus the supplied evidence does not show that this
specific evidence was lost before verification. This is a recorded input-text
projection, not an assertion that every provider request field, SYSTEM message,
response schema and raw JSON response was captured. The parsed task_completed
bit is not present verbatim in these records; source admission plus successful
browser completion is not a substitute for its raw response bytes.

PASS sibling index82 instead executes fetches of candidate article pages and
searches their returned HTML for the phrase. Index84's verifier reasoning
explicitly discusses a rolling48-hour window and the candidate pages. The
sibling's procedure and result differ; it is not a controlled experiment proving
that changing one instruction or verifier rule would fix the failed run.
Phrase occurrences in HTML/metadata also remain tool evidence, not independent
proof that all requested article bodies were exhaustively checked.

### Current diagnosis and next boundary

The first concrete shortfall visible in the failed recorded procedure is using
archive title/link matches as a completeness check for articles containing the
phrase. The recorded browser completion reasoning accepts that narrower check.
This supports the original C1 failure and an internally overbroad completion
inference. It does not establish a generic schema-generation defect, transport
loss, task-specific repair or safe deterministic verifier change. The date-window
interpretation is another difference, not independently isolated here.

The original actual query, native results, verification input projection and
three rubric results are now available. The raw schema-generation request and
response, actual provider verifier JSON including task_completed, and full
provider request envelopes for all three judges are not demonstrated in this
packet. Do not describe these investigation gaps as runtime capture loss. A
future general completion repair needs an exact owning-boundary counterfactual
and independent opened-reference review, without title/date keyword heuristics,
task edits, prompt hints or relaxed criteria.

No runtime change or speculative test was justified. Local compact evidence
(including indexed messages, recorded verifier input and rubric outputs) is
`.context/r15-it9/original-analysis-evidence.json`. Existing input originals
remain untouched. The case remains OPEN for a supported general causal repair;
the original task FAIL remains valid. Actual scope BU029 failed run and its
pinned PASS sibling; token usage UNMETERED.
